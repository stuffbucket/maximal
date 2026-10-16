import {
  Client,
  StreamableHTTPClientTransport,
  type ServerCapabilities,
} from "@modelcontextprotocol/client";
import { pathToFileURL } from "node:url";

type RequestedProtocol = "legacy" | "modern";

function requestedProtocol(args: string[]): RequestedProtocol {
  const index = args.indexOf("--protocol");
  const value = index === -1 ? "legacy" : args[index + 1];
  if (value === "legacy" || value === "modern") {
    return value;
  }
  throw new Error(`Invalid --protocol value: ${value ?? "missing"}`);
}

function capabilityReport(capabilities: ServerCapabilities) {
  return {
    completions: capabilities.completions !== undefined,
    logging: capabilities.logging !== undefined,
    prompts: capabilities.prompts !== undefined,
    resources: capabilities.resources !== undefined,
    tools: capabilities.tools !== undefined,
  };
}

async function main(): Promise<void> {
  const apiKey = process.env.SPIKE_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error("Set SPIKE_API_KEY in the environment");
  }

  const args = process.argv.slice(2);
  const endpointIndex = args.indexOf("--endpoint");
  const endpoint = new URL(
    endpointIndex === -1
      ? "http://127.0.0.1:4142/mcp"
      : (args[endpointIndex + 1] ?? ""),
  );
  const protocol = requestedProtocol(args);
  const client = new Client(
    { name: "maximal-workiq-spike-inspector", version: "0.0.0" },
    {
      capabilities: { elicitation: { form: {} } },
      inputRequired: { autoFulfill: false },
      versionNegotiation:
        protocol === "legacy"
          ? { mode: "legacy" }
          : {
              mode: { pin: "2026-07-28" },
              probe: { maxRetries: 0, timeoutMs: 5_000 },
            },
    },
  );
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { "X-API-Key": apiKey } },
  });

  try {
    await client.connect(transport, { timeout: 10_000 });
    const tools = await client.listTools();
    process.stdout.write(
      `${JSON.stringify(
        {
          advertisedCapabilities: capabilityReport(
            client.getServerCapabilities() ?? {},
          ),
          negotiatedProtocol: client.getNegotiatedProtocolVersion(),
          protocolEra: client.getProtocolEra(),
          requestedProtocol: protocol,
          toolCount: tools.tools.length,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await client.close();
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main().catch(() => {
    process.stdout.write(`${JSON.stringify({ errorCode: "InspectFailed" })}\n`);
    process.exitCode = 1;
  });
}
