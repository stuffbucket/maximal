/**
 * The connectors bench: the real Work IQ connector, composed into a real
 * Maximal server, talking to a fake Work IQ MCP server with a fake sign-in
 * that completes instantly as bench@contoso.com. No Microsoft account,
 * tenant, or network.
 *
 * `startConnectorsBench` starts the fake upstream, seeds `config.json`
 * (Work IQ on, a bench API key), builds the plugin gateway through the
 * composition root's override seam (`composePluginGateway({ plugins })`) and
 * hands it to a server starter: `scripts/bench/connectors.ts` uses
 * `runServer({ pluginGateway })`, the test serves the app in-process.
 * `driveConnectorsBench` then runs a scripted MCP client session plus
 * Settings API calls and returns a pass/fail row per check.
 *
 * Call it only with `COPILOT_API_HOME` (and the rest of the user
 * environment) pointing at a throwaway directory: it writes `config.json`.
 */

import type { PluginGateway } from "@stuffbucket/maximal-plugin-sdk/gateway"

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client"
import {
  createWorkIqPlugin,
} from "@stuffbucket/maximal-plugin-workiq"
import {
  BENCH_ACCOUNT,
  fakeAuth,
  type FakeRemoteMcp,
  startFakeWorkIq,
  WORKIQ_TOOLS,
} from "@stuffbucket/maximal-plugin-workiq/testing"
import { randomBytes } from "node:crypto"

import { writeConfig } from "../../src/lib/config/config"
import {
  PluginDetailView,
  PluginsListResponse,
} from "../../src/lib/config/settings-types"
import { composePluginGateway } from "../../src/lib/plugins/compose"

export const BENCH_PLUGIN_ID = "workiq"

/**
 * What the fake tenant allows: `full` (every fixture tool), `partial`
 * (tools/list returns the read-only tools only, as when an admin restricts
 * the agent), `none` (the account isn't enabled: every connect is a 403).
 */
export type BenchEntitlement = "full" | "partial" | "none"

export interface BenchServer {
  /** `http://127.0.0.1:<port>` of the running Maximal. */
  origin: string
  stop(): Promise<void>
}

/** Start Maximal serving `gateway`; resolve once it listens. */
export type StartBenchServer = (gateway: PluginGateway) => Promise<BenchServer>

export interface ConnectorsBenchOptions {
  entitlement?: BenchEntitlement
  startServer: StartBenchServer
  /** Plugin storage (settings file, terms, tokens); default
   *  `<app dir>/plugins`. Pass a fresh directory to start from scratch. */
  storageRoot?: string
}

export interface ConnectorsBench {
  readonly entitlement: BenchEntitlement
  readonly fake: FakeRemoteMcp
  readonly gateway: PluginGateway
  readonly origin: string
  /** Bearer key for `/mcp/workiq` and `/settings/api` (attribution only:
   *  "Block unknown connections" stays off so the browser UI works). */
  readonly apiKey: string
  readonly settingsUrl: string
  readonly mcpUrl: string
  stop(): Promise<void>
}

const READY_TIMEOUT_MS = 15_000
/** Effectively "every request": the fake consumes one per request. */
const ALWAYS = 1_000_000

function benchTools(entitlement: BenchEntitlement) {
  return entitlement === "partial" ?
      WORKIQ_TOOLS.filter((tool) => tool.annotations?.readOnlyHint === true)
    : WORKIQ_TOOLS
}

async function waitUntil(
  check: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return true
}

export async function startConnectorsBench(
  options: ConnectorsBenchOptions,
): Promise<ConnectorsBench> {
  const entitlement = options.entitlement ?? "full"
  const fake = startFakeWorkIq({ tools: benchTools(entitlement) })
  if (entitlement === "none") {
    fake.fail({ status: 403, rpc: "initialize", body: "Forbidden" }, ALWAYS)
  }
  const apiKey = `bench-${randomBytes(12).toString("hex")}`
  writeConfig({
    plugins: { [BENCH_PLUGIN_ID]: { enabled: true } },
    auth: {
      apiKeyEntries: [
        {
          id: "bench",
          label: "bench",
          key: apiKey,
          enabled: true,
          created_at: new Date().toISOString(),
        },
      ],
    },
  })

  let gateway: PluginGateway | undefined
  let server: BenchServer | undefined
  try {
    gateway = composePluginGateway({
      ...(options.storageRoot ? { storageRoot: options.storageRoot } : {}),
      plugins: [
        createWorkIqPlugin({
          endpoint: fake.url,
          auth: fakeAuth({ account: BENCH_ACCOUNT }),
          // Fail fast on an injected throttle instead of 2/4/8/16 s.
          retryDelaysMs: [10],
        }),
      ],
    })
    server = await options.startServer(gateway)
    const started = gateway
    const active = await waitUntil(
      () => started.get(BENCH_PLUGIN_ID)?.lifecycle === "active",
      READY_TIMEOUT_MS,
    )
    if (!active) {
      const snapshot = started.get(BENCH_PLUGIN_ID)
      throw new Error(
        `Work IQ did not start: ${snapshot?.lifecycle ?? "missing"} ${snapshot?.error ?? ""}`.trim(),
      )
    }
  } catch (error) {
    await server?.stop()
    await gateway?.dispose()
    await fake.close()
    throw error
  }

  const { origin } = server
  const running = server
  let stopped = false
  return {
    entitlement,
    fake,
    gateway,
    origin,
    apiKey,
    settingsUrl: `${origin}/ui/settings/#connectors/${BENCH_PLUGIN_ID}`,
    mcpUrl: `${origin}/mcp/${BENCH_PLUGIN_ID}`,
    async stop() {
      if (stopped) return
      stopped = true
      await running.stop()
      await fake.close()
    },
  }
}

// ── Drive ──────────────────────────────────────────────────────────────

export interface BenchCheck {
  name: string
  ok: boolean
  detail: string
}

interface ToolResultLike {
  isError?: boolean
  content?: Array<{ type: string; text?: string }>
}

function firstText(result: ToolResultLike): string {
  const text = result.content?.find((block) => block.type === "text")?.text
  return (text ?? "").replaceAll(/\s+/g, " ").slice(0, 70)
}

/** Arguments that satisfy a tool's required inputs (strings get "bench"). */
function sampleArguments(
  inputSchema: Record<string, unknown>,
): Record<string, unknown> {
  const properties = (inputSchema.properties ?? {}) as Record<
    string,
    { type?: unknown }
  >
  const required = Array.isArray(inputSchema.required) ?
      (inputSchema.required as Array<string>)
    : []
  const args: Record<string, unknown> = {}
  for (const name of required) {
    const type =
      Array.isArray(properties[name]?.type) ?
        (properties[name].type as Array<unknown>)[0]
      : properties[name]?.type
    if (type === "array") args[name] = ["bench"]
    else if (type === "number" || type === "integer") args[name] = 1
    else if (type === "boolean") args[name] = true
    else if (type === "object") args[name] = {}
    else args[name] = "bench"
  }
  return args
}

class Checks {
  readonly rows: Array<BenchCheck> = []

  record(name: string, ok: boolean, detail: string): boolean {
    this.rows.push({ name, ok, detail })
    return ok
  }

  async run(name: string, body: () => Promise<string>): Promise<boolean> {
    try {
      return this.record(name, true, await body())
    } catch (error) {
      return this.record(
        name,
        false,
        error instanceof Error ? error.message : String(error),
      )
    }
  }
}

function expectThat(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

class SettingsApi {
  readonly #bench: ConnectorsBench

  constructor(bench: ConnectorsBench) {
    this.#bench = bench
  }

  async #request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    return fetch(`${this.#bench.origin}/settings/api/plugins${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#bench.apiKey}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }

  async detail(): Promise<PluginDetailView> {
    const response = await this.#request("GET", `/${BENCH_PLUGIN_ID}`)
    expectThat(response.ok, `GET detail answered ${response.status}`)
    return PluginDetailView.parse(await response.json())
  }

  async list(): Promise<PluginsListResponse> {
    const response = await this.#request("GET", "")
    expectThat(response.ok, `GET list answered ${response.status}`)
    return PluginsListResponse.parse(await response.json())
  }

  async action(actionId: string): Promise<void> {
    const response = await this.#request(
      "POST",
      `/${BENCH_PLUGIN_ID}/actions/${actionId}`,
    )
    expectThat(
      response.status === 202,
      `${actionId} answered ${response.status}`,
    )
  }

  async permissions(
    permissions: Record<string, "allow" | "block" | null>,
  ): Promise<PluginDetailView> {
    const response = await this.#request(
      "PUT",
      `/${BENCH_PLUGIN_ID}/tool-permissions`,
      { permissions },
    )
    expectThat(response.ok, `PUT tool-permissions answered ${response.status}`)
    return PluginDetailView.parse(await response.json())
  }

  /** Poll the detail until `check` holds; the last detail either way. */
  async waitFor(
    check: (view: PluginDetailView) => boolean,
    timeoutMs = READY_TIMEOUT_MS,
  ): Promise<PluginDetailView> {
    let last = await this.detail()
    await waitUntil(async () => {
      last = await this.detail()
      return check(last)
    }, timeoutMs)
    return last
  }
}

async function connectClient(
  bench: ConnectorsBench,
): Promise<{ client: Client; listChanged: () => number }> {
  const client = new Client({ name: "maximal-bench", version: "1.0.0" })
  let changes = 0
  await client.connect(
    new StreamableHTTPClientTransport(new URL(bench.mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${bench.apiKey}` } },
    }),
  )
  client.setNotificationHandler("notifications/tools/list_changed", () => {
    changes += 1
  })
  // Let the client open its standalone SSE stream (notifications ride it).
  await new Promise((resolve) => setTimeout(resolve, 150))
  return { client, listChanged: () => changes }
}

async function toolNames(client: Client): Promise<Array<string>> {
  return (await client.listTools()).tools.map((tool) => tool.name)
}

/** Whether `name` is listed as turned off (blocked tools stay listed). */
async function listedAsOff(client: Client, name: string): Promise<boolean> {
  const tool = (await client.listTools()).tools.find((t) => t.name === name)
  return tool?.description?.includes("is turned off in Maximal") === true
}

/** Accept the terms and sign in through the Settings API, as a user would. */
async function setUp(
  checks: Checks,
  api: SettingsApi,
): Promise<PluginDetailView | undefined> {
  let view = await api.waitFor((v) => v.status?.code === "terms-needed")
  const gated = checks.record(
    "Settings shows the terms gate first",
    view.status?.code === "terms-needed",
    `status ${view.status?.code ?? "none"}`,
  )
  if (!gated) return undefined
  await api.action("accept-terms")
  view = await api.waitFor((v) => v.status?.code === "signin-needed")
  await api.action("sign-in")
  view = await api.waitFor(
    (v) => v.status?.state === "ready" || v.status?.state === "error",
  )
  return view
}

async function driveEntitled(
  checks: Checks,
  api: SettingsApi,
  bench: ConnectorsBench,
  view: PluginDetailView,
): Promise<void> {
  const expected = benchTools(bench.entitlement)
  const account = view.status?.facts?.find((fact) => fact.label === "Account")
  checks.record(
    `Signs in instantly as ${BENCH_ACCOUNT.username}`,
    view.status?.state === "ready" && account?.value === BENCH_ACCOUNT.username,
    `status ${view.status?.code ?? "none"}, account ${account?.value ?? "none"}`,
  )

  await checks.run("Settings lists the tools by group", async () => {
    const { plugins } = await api.list()
    const counts = plugins.find((p) => p.id === BENCH_PLUGIN_ID)?.toolCounts
    const want = { "read-only": 0, "write-delete": 0, other: 0 }
    for (const tool of expected) {
      if (tool.annotations?.readOnlyHint === true) want["read-only"] += 1
      else if (tool.annotations?.destructiveHint === true)
        want["write-delete"] += 1
      else want.other += 1
    }
    const got = counts?.byGroup
    expectThat(
      counts?.total === expected.length
        && got?.["read-only"] === want["read-only"]
        && got["write-delete"] === want["write-delete"]
        && got.other === want.other,
      `counts ${JSON.stringify(counts)}`,
    )
    return `${counts.total} tools: read-only ${got["read-only"]}, write/delete ${got["write-delete"]}, other ${got.other}`
  })

  const { client, listChanged } = await connectClient(bench)
  try {
    await checks.run("MCP tools/list shows every tool", async () => {
      const names = await toolNames(client)
      expectThat(
        names.length === expected.length,
        `${names.length} tools, want ${expected.length}`,
      )
      return `${names.length} tools over /mcp/${BENCH_PLUGIN_ID}`
    })

    const allowed = expected.find((tool) => tool.name === "retrieve") ?? expected[0]
    const target =
      expected.find((tool) => tool.name === "delete_entity")
      ?? expected.find((tool) => tool.name !== allowed.name)
    if (!target) {
      checks.record("Pick a tool to block", false, "fixture has one tool")
      return
    }

    await checks.run(`Block ${target.name} in Settings`, async () => {
      const before = listChanged()
      const detail = await api.permissions({ [target.name]: "block" })
      const row = detail.tools.find((tool) => tool.name === target.name)
      expectThat(
        row?.permission === "block" && row.permissionSource === "user",
        `Settings shows ${row?.permission ?? "nothing"}`,
      )
      const notified = await waitUntil(() => listChanged() > before, 5_000)
      expectThat(notified, "no tools/list_changed")
      const names = await toolNames(client)
      expectThat(names.includes(target.name), "no longer listed")
      expectThat(
        await listedAsOff(client, target.name),
        "listed without saying it's turned off",
      )
      return `list_changed received; listed as turned off`
    })

    await checks.run(`Calling blocked ${target.name} is refused`, async () => {
      const result = (await client.callTool({
        name: target.name,
        arguments: sampleArguments(target.inputSchema),
      })) as ToolResultLike
      expectThat(result.isError === true, "the call ran")
      const text = firstText(result)
      expectThat(text.includes("turned off"), `said "${text}"`)
      return `isError: ${text}`
    })

    await checks.run(`Allow ${target.name}`, async () => {
      const before = listChanged()
      // Not just cleared: Work IQ's own default keeps delete_entity off.
      await api.permissions({ [target.name]: "allow" })
      const notified = await waitUntil(() => listChanged() > before, 5_000)
      expectThat(notified, "no tools/list_changed")
      expectThat(
        !(await listedAsOff(client, target.name)),
        "still listed as turned off",
      )
      return "list_changed received; listed as usable"
    })

    const callAllowed = async () =>
      (await client.callTool({
        name: allowed.name,
        arguments: sampleArguments(allowed.inputSchema),
      })) as ToolResultLike

    await checks.run(`Call allowed ${allowed.name}`, async () => {
      const result = await callAllowed()
      expectThat(result.isError !== true, `isError: ${firstText(result)}`)
      return firstText(result)
    })

    await checks.run("Policy-denied call (HTTP 403) is an error result", async () => {
      bench.fake.fail({
        status: 403,
        rpc: "tools/call",
        body: '{"error":{"code":"Forbidden","message":"Access denied by policy"}}',
      })
      const result = await callAllowed()
      expectThat(result.isError === true, "the call succeeded")
      return `isError: ${firstText(result)}`
    })

    await checks.run("Connector still works after the denial", async () => {
      const status = (await api.detail()).status
      expectThat(status?.state === "ready", `status ${status?.code ?? "none"}`)
      const result = await callAllowed()
      expectThat(result.isError !== true, `isError: ${firstText(result)}`)
      return `status ready; ${allowed.name} answered`
    })
  } finally {
    await client.close().catch(() => undefined)
  }
}

async function driveNotEntitled(
  checks: Checks,
  bench: ConnectorsBench,
  view: PluginDetailView,
): Promise<void> {
  checks.record(
    "Not-entitled account shows an admin error",
    view.status?.state === "error"
      && /hasn.t enabled/i.test(view.status.summary),
    view.status?.summary ?? "no status",
  )
  checks.record(
    "Sign-in is kept (Try again offered)",
    view.status?.actions?.some((action) => action.id === "retry") === true,
    (view.status?.actions ?? []).map((action) => action.id).join(", "),
  )
  const { client } = await connectClient(bench)
  try {
    await checks.run("MCP tools/list is empty", async () => {
      const names = await toolNames(client)
      expectThat(names.length === 0, `${names.length} tools`)
      return "0 tools"
    })
    await checks.run("A call explains the connector isn't ready", async () => {
      const result = (await client.callTool({
        name: "retrieve",
        arguments: { query: "bench" },
      }).catch((error: unknown) => ({
        isError: true,
        content: [{ type: "text", text: String(error) }],
      }))) as ToolResultLike
      expectThat(result.isError === true, "the call ran")
      const text = firstText(result)
      expectThat(text.includes("isn't ready"), `said "${text}"`)
      return `isError: ${text}`
    })
  } finally {
    await client.close().catch(() => undefined)
  }
}

/** The scripted session. Never throws; a failed step is a failed row. */
export async function driveConnectorsBench(
  bench: ConnectorsBench,
): Promise<Array<BenchCheck>> {
  const checks = new Checks()
  const api = new SettingsApi(bench)
  try {
    const view = await setUp(checks, api)
    if (view) {
      if (bench.entitlement === "none") {
        await driveNotEntitled(checks, bench, view)
      } else {
        await driveEntitled(checks, api, bench, view)
      }
    }
  } catch (error) {
    checks.record(
      "Drive",
      false,
      error instanceof Error ? error.message : String(error),
    )
  }
  return checks.rows
}

/** A plain-text pass/fail table. */
export function formatChecks(rows: ReadonlyArray<BenchCheck>): string {
  const width = Math.max(5, ...rows.map((row) => row.name.length))
  const lines = [
    ` #  ${"Check".padEnd(width)}  Result  Detail`,
    ` -- ${"-".repeat(width)}  ------  ${"-".repeat(40)}`,
    ...rows.map(
      (row, index) =>
        `${String(index + 1).padStart(2)}  ${row.name.padEnd(width)}  ${row.ok ? "PASS  " : "FAIL  "}  ${row.detail}`,
    ),
  ]
  const failed = rows.filter((row) => !row.ok).length
  lines.push(
    "",
    failed === 0 ?
      `All ${rows.length} checks passed.`
    : `${failed} of ${rows.length} checks failed.`,
  )
  return lines.join("\n")
}
