import {
  Client,
  isInputRequiredResult,
  SdkError,
  StreamableHTTPClientTransport,
  type CallToolRequestParams,
  type CallToolResult,
  type ElicitResult,
  type InputRequiredResult,
  type InputResponses,
  type ServerCapabilities,
} from "@modelcontextprotocol/client";
import { pathToFileURL } from "node:url";
import type { ProxyMode } from "./proxy.ts";

const PACKAGE_VERSIONS = {
  "@microsoft/workiq": "1.0.1",
  "@modelcontextprotocol/client": "2.3.1",
  "@modelcontextprotocol/core": "2.3.1",
  "@modelcontextprotocol/server": "2.3.1",
  "@modelcontextprotocol/server-legacy": "2.3.1",
  "mcp-proxy": "6.7.19",
} as const;

type RequestedProtocol = "auto" | "legacy" | "modern";
type ProbeOutcome = "accept" | "cancel" | "decline";
type ProbeScenario =
  | "interactive_never"
  | "interactive_one"
  | "interactive_two";

type RetryCallToolParams = CallToolRequestParams & {
  inputResponses?: InputResponses;
  requestState?: string;
};

export interface ProbeOptions {
  apiKey: string;
  endpoint: URL;
  maxRounds?: number;
  outcome: ProbeOutcome;
  proxyMode: ProxyMode;
  requestedProtocol: RequestedProtocol;
  scenario: ProbeScenario;
}

export interface ProbeReport {
  advertisedCapabilities: {
    tools: boolean;
  };
  cancellation: "aborted" | "not-tested" | "unexpected-result";
  errorCode?: string;
  interaction: "input_required" | "legacy-elicitation" | "none";
  negotiatedProtocol?: string;
  ordinaryCall: "ok";
  packageVersions: typeof PACKAGE_VERSIONS;
  progressCount: number;
  protocolEra?: "legacy" | "modern";
  proxyMode: ProxyMode;
  requestedProtocol: RequestedProtocol;
  roundCount: number;
  scenario: ProbeScenario;
  terminalOutcome: ProbeOutcome | "error" | "round-limit";
  timeout: "not-tested" | "timed-out" | "unexpected-result";
}

function versionNegotiation(requested: RequestedProtocol) {
  if (requested === "legacy") {
    return { mode: "legacy" as const };
  }
  if (requested === "modern") {
    return {
      mode: { pin: "2026-07-28" as const },
      probe: { maxRetries: 0, timeoutMs: 5_000 },
    };
  }
  return {
    mode: "auto" as const,
    probe: { maxRetries: 0, timeoutMs: 5_000 },
  };
}

function elicitationResult(outcome: ProbeOutcome): ElicitResult {
  return outcome === "accept"
    ? { action: "accept", content: { confirmed: true } }
    : { action: outcome };
}

function hasExactTextResult(
  result: CallToolResult,
  expected: string,
): boolean {
  const [content] = result.content;
  return (
    result.isError !== true &&
    result.content.length === 1 &&
    content?.type === "text" &&
    content.text === expected
  );
}

function errorCode(error: unknown): string | undefined {
  if (SdkError.isInstance(error)) {
    return String(error.code);
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (typeof error.code === "string" || typeof error.code === "number")
  ) {
    return String(error.code);
  }
  return undefined;
}

async function callToolAllowingInput(
  client: Client,
  params: CallToolRequestParams,
  options?: {
    onprogress?: () => void;
    signal?: AbortSignal;
    timeout?: number;
  },
): Promise<CallToolResult | InputRequiredResult> {
  const result = await client.callTool(params, {
    allowInputRequired: true,
    onprogress: options?.onprogress,
    signal: options?.signal,
    timeout: options?.timeout,
  });
  return result as CallToolResult | InputRequiredResult;
}

function responseForRequests(
  result: InputRequiredResult,
  outcome: ProbeOutcome,
): InputResponses {
  return Object.fromEntries(
    Object.keys(result.inputRequests ?? {}).map((key) => [
      key,
      elicitationResult(outcome),
    ]),
  );
}

async function runInteraction(
  client: Client,
  options: ProbeOptions,
): Promise<{
  errorCode?: string;
  interaction: "input_required" | "legacy-elicitation" | "none";
  roundCount: number;
  terminalOutcome: ProbeReport["terminalOutcome"];
}> {
  const maxRounds = options.maxRounds ?? 4;
  let params: RetryCallToolParams = {
    arguments: {},
    name: options.scenario,
  };
  let roundCount = 0;
  let sawInputRequired = false;
  const accumulatedResponses: InputResponses = {};

  try {
    while (true) {
      const result = await callToolAllowingInput(client, params);
      if (!isInputRequiredResult(result)) {
        const expectedResult = `terminal:${options.outcome}:rounds:${roundCount}`;
        return {
          interaction: sawInputRequired ? "input_required" : "none",
          roundCount,
          terminalOutcome: hasExactTextResult(result, expectedResult)
            ? options.outcome
            : "error",
        };
      }

      sawInputRequired = true;
      if (roundCount >= maxRounds) {
        return {
          interaction: "input_required",
          roundCount,
          terminalOutcome: "round-limit",
        };
      }

      Object.assign(
        accumulatedResponses,
        responseForRequests(result, options.outcome),
      );
      roundCount += 1;
      params = {
        arguments: {},
        inputResponses: accumulatedResponses,
        name: options.scenario,
        requestState: result.requestState,
      };
    }
  } catch (error: unknown) {
    return {
      errorCode: errorCode(error),
      interaction: sawInputRequired ? "input_required" : "none",
      roundCount,
      terminalOutcome: "error",
    };
  }
}

async function checkCancellation(
  client: Client,
): Promise<ProbeReport["cancellation"]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 50);
  try {
    await callToolAllowingInput(
      client,
      { arguments: {}, name: "delay" },
      { signal: controller.signal },
    );
    return "unexpected-result";
  } catch {
    return controller.signal.aborted ? "aborted" : "unexpected-result";
  } finally {
    clearTimeout(timer);
  }
}

async function checkTimeout(client: Client): Promise<ProbeReport["timeout"]> {
  try {
    await callToolAllowingInput(
      client,
      { arguments: {}, name: "delay" },
      { timeout: 50 },
    );
    return "unexpected-result";
  } catch (error: unknown) {
    return errorCode(error) === "REQUEST_TIMEOUT"
      ? "timed-out"
      : "unexpected-result";
  }
}

export async function runProbe(options: ProbeOptions): Promise<ProbeReport> {
  if (options.apiKey.length === 0) {
    throw new Error("A non-empty API key is required");
  }

  let legacyElicitationCount = 0;
  let progressCount = 0;
  const client = new Client(
    { name: "maximal-workiq-spike-probe", version: "0.0.0" },
    {
      capabilities: { elicitation: { form: {} } },
      inputRequired: { autoFulfill: false },
      versionNegotiation: versionNegotiation(options.requestedProtocol),
    },
  );
  client.setRequestHandler("elicitation/create", async (): Promise<ElicitResult> => {
    legacyElicitationCount += 1;
    return elicitationResult(options.outcome);
  });

  const transport = new StreamableHTTPClientTransport(options.endpoint, {
    requestInit: {
      headers: { "X-API-Key": options.apiKey },
    },
  });

  try {
    await client.connect(transport, { timeout: 10_000 });
    const ordinaryResult = await client.callTool({
      arguments: {},
      name: "ordinary",
    });
    if (!hasExactTextResult(ordinaryResult, "ordinary-ok")) {
      throw new Error("The deterministic ordinary call did not complete");
    }
    await client.callTool(
      { arguments: {}, name: "progress" },
      {
        onprogress: () => {
          progressCount += 1;
        },
      },
    );

    const interaction = await runInteraction(client, options);
    const capabilities: ServerCapabilities =
      client.getServerCapabilities() ?? {};
    const cancellation = await checkCancellation(client);
    const timeout = await checkTimeout(client);

    return {
      advertisedCapabilities: {
        tools: capabilities.tools !== undefined,
      },
      cancellation,
      errorCode: interaction.errorCode,
      interaction:
        legacyElicitationCount > 0
          ? "legacy-elicitation"
          : interaction.interaction,
      negotiatedProtocol: client.getNegotiatedProtocolVersion(),
      ordinaryCall: "ok",
      packageVersions: PACKAGE_VERSIONS,
      progressCount,
      protocolEra: client.getProtocolEra(),
      proxyMode: options.proxyMode,
      requestedProtocol: options.requestedProtocol,
      roundCount: interaction.roundCount,
      scenario: options.scenario,
      terminalOutcome: interaction.terminalOutcome,
      timeout,
    };
  } finally {
    await client.close();
  }
}

function parseEnum<T extends string>(
  args: string[],
  flag: string,
  fallback: T,
  allowed: readonly T[],
): T {
  const index = args.indexOf(flag);
  const value = index === -1 ? fallback : args[index + 1];
  if (value !== undefined && allowed.includes(value as T)) {
    return value as T;
  }
  throw new Error(`Invalid ${flag} value: ${value ?? "missing"}`);
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
  const report = await runProbe({
    apiKey,
    endpoint,
    outcome: parseEnum(
      args,
      "--outcome",
      "accept",
      ["accept", "decline", "cancel"] as const,
    ),
    proxyMode: parseEnum(
      args,
      "--proxy-mode",
      "stock",
      ["stock", "modern-forward"] as const,
    ),
    requestedProtocol: parseEnum(
      args,
      "--protocol",
      "modern",
      ["auto", "legacy", "modern"] as const,
    ),
    scenario: parseEnum(
      args,
      "--scenario",
      "interactive_two",
      ["interactive_one", "interactive_two", "interactive_never"] as const,
    ),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main().catch((error: unknown) => {
    const code = errorCode(error) ?? "ProbeFailed";
    process.stdout.write(`${JSON.stringify({ errorCode: code })}\n`);
    process.exitCode = 1;
  });
}
