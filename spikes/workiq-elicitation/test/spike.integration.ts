import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runProbe, type ProbeOptions } from "../src/probe.ts";
import {
  startProxy,
  type ProxyMode,
  type RunningProxy,
} from "../src/proxy.ts";

const API_KEY = "deterministic-spike-test-key";
const FIXTURE_PATH = fileURLToPath(new URL("../src/fixture.ts", import.meta.url));
const runningProxies = new Set<RunningProxy>();
const temporaryDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all([...runningProxies].map((proxy) => proxy.close()));
  runningProxies.clear();
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
  temporaryDirectories.clear();
});

function environment(overrides: Record<string, string>): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    ...overrides,
  };
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Failed to reserve a test port");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return address.port;
}

async function fixtureProxy({
  era = "modern",
  mode,
}: {
  era?: "legacy" | "modern";
  mode: ProxyMode;
}): Promise<{
  cancellationFile: string;
  endpoint: URL;
  pid: number;
  proxy: RunningProxy;
}> {
  const port = await unusedPort();
  const directory = await mkdtemp(join(tmpdir(), "maximal-workiq-spike-"));
  temporaryDirectories.add(directory);
  const cancellationFile = join(directory, "fixture.cancelled");
  const pidFile = join(directory, "fixture.pid");
  const proxy = await startProxy({
    apiKey: API_KEY,
    mode,
    port,
    upstream: {
      args: [FIXTURE_PATH, "--era", era],
      command: process.execPath,
      env: environment({
        SPIKE_FIXTURE_CANCEL_FILE: cancellationFile,
        SPIKE_FIXTURE_PID_FILE: pidFile,
      }),
      stderr: "inherit",
    },
    upstreamProtocol: era,
  });
  runningProxies.add(proxy);
  return {
    cancellationFile,
    endpoint: new URL(`http://127.0.0.1:${port}/mcp`),
    pid: Number(await readFile(pidFile, "utf8")),
    proxy,
  };
}

async function probe(
  endpoint: URL,
  overrides: Partial<ProbeOptions> = {},
) {
  return runProbe({
    apiKey: API_KEY,
    endpoint,
    outcome: "accept",
    proxyMode: "modern-forward",
    requestedProtocol: "modern",
    scenario: "interactive_two",
    ...overrides,
  });
}

async function waitForFile(path: string): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await readFile(path);
      return true;
    } catch (error: unknown) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
    await Bun.sleep(10);
  }
  return false;
}

async function waitForExit(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH"
      ) {
        return true;
      }
      throw error;
    }
    await Bun.sleep(10);
  }
  return false;
}

function legacyClient(
  endpoint: URL,
  extraHeaders: Record<string, string> = {},
): {
  client: Client;
  connect(): Promise<void>;
} {
  const client = new Client(
    { name: "legacy-session-test", version: "0.0.0" },
    { versionNegotiation: { mode: "legacy" } },
  );
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: {
      headers: { "X-API-Key": API_KEY, ...extraHeaders },
    },
  });
  return {
    client,
    async connect() {
      await client.connect(transport, { timeout: 5_000 });
    },
  };
}

describe("authenticated loopback transport", () => {
  test("rejects missing and wrong API keys and accepts the dedicated key", async () => {
    const { endpoint } = await fixtureProxy({ mode: "modern-forward" });
    const request = {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "auth-test", version: "0.0.0" },
          protocolVersion: "2026-07-28",
        },
      }),
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      method: "POST",
    } satisfies RequestInit;

    expect((await fetch(endpoint, request)).status).toBe(401);
    expect(
      (
        await fetch(endpoint, {
          ...request,
          headers: { ...request.headers, "X-API-Key": "wrong-key" },
        })
      ).status,
    ).toBe(401);

    const report = await probe(endpoint, { scenario: "interactive_one" });
    expect(report.ordinaryCall).toBe("ok");
  });

  test("does not bind the HTTP listener to IPv6", async () => {
    const { endpoint } = await fixtureProxy({ mode: "modern-forward" });
    const ipv6Endpoint = new URL(endpoint);
    ipv6Endpoint.hostname = "[::1]";
    await expect(fetch(ipv6Endpoint)).rejects.toThrow();
  });
});

describe("stock proxy characterization", () => {
  test("forwards ordinary calls but not modern input_required", async () => {
    const { endpoint } = await fixtureProxy({ mode: "stock" });
    const report = await probe(endpoint, {
      proxyMode: "stock",
      scenario: "interactive_one",
    });

    expect(report.ordinaryCall).toBe("ok");
    expect(report.progressCount).toBeGreaterThan(0);
    expect(report.interaction).toBe("none");
    expect(report.terminalOutcome).toBe("error");
  });

  test("does not falsely route legacy elicitation", async () => {
    const { endpoint } = await fixtureProxy({ era: "legacy", mode: "stock" });
    const report = await probe(endpoint, {
      proxyMode: "stock",
      requestedProtocol: "legacy",
      scenario: "interactive_one",
    });

    expect(report.protocolEra).toBe("legacy");
    expect(report.interaction).toBe("none");
    expect(report.terminalOutcome).toBe("error");
  });
});

describe("modern input_required forwarding", () => {
  test("completes one and two rounds with fresh request IDs and opaque state", async () => {
    const { endpoint } = await fixtureProxy({ mode: "modern-forward" });
    const oneRound = await probe(endpoint, { scenario: "interactive_one" });
    const twoRounds = await probe(endpoint, { scenario: "interactive_two" });

    expect(oneRound.interaction).toBe("input_required");
    expect(oneRound.roundCount).toBe(1);
    expect(oneRound.terminalOutcome).toBe("accept");
    expect(twoRounds.interaction).toBe("input_required");
    expect(twoRounds.roundCount).toBe(2);
    expect(twoRounds.terminalOutcome).toBe("accept");
  });

  test.each(["accept", "decline", "cancel"] as const)(
    "preserves the %s terminal outcome",
    async (outcome) => {
      const { endpoint } = await fixtureProxy({ mode: "modern-forward" });
      const report = await probe(endpoint, {
        outcome,
        scenario: "interactive_one",
      });

      expect(report.interaction).toBe("input_required");
      expect(report.terminalOutcome).toBe(outcome);
    },
  );

  test("enforces the caller's round limit", async () => {
    const { endpoint } = await fixtureProxy({ mode: "modern-forward" });
    const report = await probe(endpoint, {
      maxRounds: 2,
      scenario: "interactive_never",
    });

    expect(report.interaction).toBe("input_required");
    expect(report.roundCount).toBe(2);
    expect(report.terminalOutcome).toBe("round-limit");
  });

  test("preserves progress and identifies the upstream cancellation gap", async () => {
    const { cancellationFile, endpoint } = await fixtureProxy({
      mode: "modern-forward",
    });
    const report = await probe(endpoint, { scenario: "interactive_one" });

    expect(report.progressCount).toBeGreaterThan(0);
    expect(report.cancellation).toBe("aborted");
    expect(report.timeout).toBe("timed-out");
    expect(await waitForFile(cancellationFile)).toBe(false);
  });
});

describe("resource cleanup and legacy session ownership", () => {
  test("terminates the stdio child when listener startup fails", async () => {
    const occupiedListener = createServer();
    await new Promise<void>((resolve, reject) => {
      occupiedListener.once("error", reject);
      occupiedListener.listen(0, "127.0.0.1", resolve);
    });
    const address = occupiedListener.address();
    if (address === null || typeof address === "string") {
      throw new Error("Failed to occupy a test port");
    }

    const directory = await mkdtemp(join(tmpdir(), "maximal-workiq-spike-"));
    temporaryDirectories.add(directory);
    const pidFile = join(directory, "fixture.pid");

    try {
      await expect(
        startProxy({
          apiKey: API_KEY,
          mode: "modern-forward",
          port: address.port,
          upstream: {
            args: [FIXTURE_PATH, "--era", "modern"],
            command: process.execPath,
            env: environment({ SPIKE_FIXTURE_PID_FILE: pidFile }),
            stderr: "inherit",
          },
          upstreamProtocol: "modern",
        }),
      ).rejects.toThrow();

      const pid = Number(await readFile(pidFile, "utf8"));
      expect(await waitForExit(pid)).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        occupiedListener.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      });
    }
  });

  test("closes the listener and terminates the stdio child", async () => {
    const { endpoint, pid, proxy } = await fixtureProxy({
      mode: "modern-forward",
    });
    await probe(endpoint, { scenario: "interactive_one" });
    await proxy.close();
    runningProxies.delete(proxy);

    expect(await waitForExit(pid)).toBe(true);
    await expect(fetch(endpoint)).rejects.toThrow();
  });

  test("rejects a second legacy session despite spoofed modern headers", async () => {
    const { endpoint } = await fixtureProxy({ era: "legacy", mode: "stock" });
    const first = legacyClient(endpoint);
    const second = legacyClient(endpoint, {
      "Mcp-Method": "server/discover",
    });
    await first.connect();

    await expect(second.connect()).rejects.toThrow();
    await Promise.allSettled([first.client.close(), second.client.close()]);
  });
});
