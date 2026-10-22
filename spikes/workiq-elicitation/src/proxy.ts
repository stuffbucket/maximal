import { Client, type ClientOptions } from "@modelcontextprotocol/client";
import {
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/client/stdio";
import { Server } from "@modelcontextprotocol/server";
import {
  proxyServer,
  resolveVersionNegotiation,
  startHTTPServer,
  type UpstreamProtocol,
} from "mcp-proxy";
import { pathToFileURL } from "node:url";
import { installInputRequiredToolForwarder } from "./forward-input-required.ts";

export type ProxyMode = "modern-forward" | "stock";

export interface StartProxyOptions {
  apiKey: string;
  mode: ProxyMode;
  port: number;
  requestTimeout?: number;
  upstream: StdioServerParameters;
  upstreamProtocol: UpstreamProtocol;
}

export interface RunningProxy {
  close(): Promise<void>;
  negotiatedProtocol: string | undefined;
  protocolEra: "legacy" | "modern" | undefined;
  serverCapabilities: ReturnType<Client["getServerCapabilities"]>;
}

function upstreamClientOptions(
  upstreamProtocol: UpstreamProtocol,
): ClientOptions {
  return {
    capabilities: {
      elicitation: {
        form: {},
      },
    },
    inputRequired: {
      autoFulfill: false,
    },
    versionNegotiation: resolveVersionNegotiation(upstreamProtocol),
  };
}

export async function startProxy(
  options: StartProxyOptions,
): Promise<RunningProxy> {
  if (options.apiKey.length === 0) {
    throw new Error("A dedicated non-empty API key is required");
  }

  const client = new Client(
    { name: "maximal-workiq-elicitation-spike", version: "0.0.0" },
    upstreamClientOptions(options.upstreamProtocol),
  );
  const transport = new StdioClientTransport(options.upstream);
  try {
    await client.connect(transport, { timeout: 30_000 });
  } catch (error: unknown) {
    await client.close().catch(() => undefined);
    throw error;
  }

  const serverCapabilities = client.getServerCapabilities() ?? {};
  const serverVersion = client.getServerVersion() ?? {
    name: "anonymous-upstream",
    version: "unknown",
  };
  const upstreamEra = client.getProtocolEra();
  let activeLegacyServer: Server | undefined;

  let httpServer;
  try {
    httpServer = await startHTTPServer({
      apiKey: options.apiKey,
      createServer: async () => {
        const server = new Server(serverVersion, {
          capabilities: serverCapabilities,
          inputRequired: { legacyShim: false },
          instructions: client.getInstructions(),
        });
        await proxyServer({
          client,
          requestTimeout: options.requestTimeout,
          server,
          serverCapabilities,
        });

        if (options.mode === "modern-forward" && serverCapabilities.tools) {
          installInputRequiredToolForwarder({
            client,
            requestTimeout: options.requestTimeout,
            server,
          });
        }
        return server;
      },
      enableJsonResponse: true,
      eventStore: false,
      host: "127.0.0.1",
      modern: upstreamEra === "modern",
      onClose: async (server) => {
        if (activeLegacyServer === server) {
          activeLegacyServer = undefined;
        }
      },
      onConnect: async (server) => {
        if (upstreamEra === "modern") {
          return;
        }
        if (activeLegacyServer !== undefined && activeLegacyServer !== server) {
          throw new Error("The spike permits only one legacy downstream session");
        }
        activeLegacyServer = server;
      },
      port: options.port,
      sseEndpoint: null,
      stateless: false,
      streamEndpoint: "/mcp",
    });
  } catch (error: unknown) {
    await client.close().catch(() => undefined);
    throw error;
  }

  let closed = false;
  return {
    negotiatedProtocol: client.getNegotiatedProtocolVersion(),
    protocolEra: client.getProtocolEra(),
    serverCapabilities,
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      await httpServer.close();
      await client.close();
    },
  };
}

interface CliOptions {
  mode: ProxyMode;
  port: number;
  requestTimeout?: number;
  upstream: StdioServerParameters;
  upstreamProtocol: UpstreamProtocol;
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value === "--") {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseCli(args: string[]): CliOptions {
  const separator = args.indexOf("--");
  const proxyArgs = separator === -1 ? args : args.slice(0, separator);
  const upstreamArgs = separator === -1 ? [] : args.slice(separator + 1);
  let mode: ProxyMode = "stock";
  let port = 4142;
  let requestTimeout: number | undefined;
  let upstreamProtocol: UpstreamProtocol = "auto";

  for (let index = 0; index < proxyArgs.length; index += 1) {
    const flag = proxyArgs[index];
    if (flag === "--mode") {
      const value = requiredValue(proxyArgs, index, flag);
      if (value !== "stock" && value !== "modern-forward") {
        throw new Error(`Invalid --mode value: ${value}`);
      }
      mode = value;
      index += 1;
    } else if (flag === "--port") {
      port = Number(requiredValue(proxyArgs, index, flag));
      index += 1;
    } else if (flag === "--request-timeout") {
      requestTimeout = Number(requiredValue(proxyArgs, index, flag));
      index += 1;
    } else if (flag === "--upstream-protocol") {
      const value = requiredValue(proxyArgs, index, flag);
      if (value !== "auto" && value !== "legacy" && value !== "modern") {
        throw new Error(`Invalid --upstream-protocol value: ${value}`);
      }
      upstreamProtocol = value;
      index += 1;
    } else {
      throw new Error(`Unknown proxy option: ${flag}`);
    }
  }

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid --port value: ${port}`);
  }
  if (
    requestTimeout !== undefined &&
    (!Number.isFinite(requestTimeout) || requestTimeout <= 0)
  ) {
    throw new Error(`Invalid --request-timeout value: ${requestTimeout}`);
  }
  if (upstreamArgs.length === 0) {
    throw new Error("Specify the stdio upstream after --");
  }

  const [command, ...commandArgs] = upstreamArgs;
  if (command === undefined) {
    throw new Error("Specify the stdio upstream after --");
  }

  return {
    mode,
    port,
    requestTimeout,
    upstream: {
      args: commandArgs,
      command,
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      stderr: "inherit",
    },
    upstreamProtocol,
  };
}

async function main(): Promise<void> {
  const apiKey = process.env.SPIKE_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error("Set SPIKE_API_KEY in the environment");
  }

  const options = parseCli(process.argv.slice(2));
  const running = await startProxy({ apiKey, ...options });
  console.error(
    `[spike] ready host=127.0.0.1 port=${options.port} mode=${options.mode} upstreamEra=${running.protocolEra ?? "unknown"} upstreamProtocol=${running.negotiatedProtocol ?? "unknown"}`,
  );

  const close = () => {
    void running.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown startup error";
    console.error(`[spike] startup failed: ${message}`);
    process.exitCode = 1;
  });
}
