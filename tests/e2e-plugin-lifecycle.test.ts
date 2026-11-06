/**
 * The Work IQ connector through its whole lifecycle, end to end and
 * in-process: the real Maximal app (the `server` Hono app on a loopback
 * port plus `startPlugins({ gateway })` — what `runServer({ pluginGateway })`
 * does after binding, the connectors-bench seam) serving a real plugin host
 * built by the lifecycle harness (`@stuffbucket/maximal-plugin-host/testing`)
 * around the real Work IQ module, wired to the fake Work IQ upstream
 * (`startFakeWorkIq`) with a fake sign-in that keeps a token cache in the
 * connector's storage. It is driven like a user and a client would: the
 * Settings HTTP API, the Settings events stream (SSE) and a real MCP client
 * session on `/mcp/workiq`.
 *
 * Claude Code is on the other side of the connector: a fake `claude` first
 * on PATH (`helpers/fake-claude-cli`) is the install Maximal finds, Maximal
 * writes `maximal-workiq` into a temp `CLAUDE_CONFIG_DIR/.claude.json`, and
 * the MCP client connects with exactly the URL and headers that entry gives
 * Claude Code. The run starts as an upgrade (an older Maximal's `workiq`
 * entry in Claude Code) and covers the user's own Work IQ taking precedence.
 *
 * Every boundary is recorded per step — the plugin transcript (fibers,
 * gateway events, status, tools, settings.json diffs, storage names,
 * openExternal, logs), Settings API exchanges, `plugins.changed` frames,
 * downstream MCP messages, upstream requests seen by the fake, settings.json
 * and config.json — normalised (ports, ids, times, durations, secrets) and
 * compared with a committed snapshot (`__snapshots__/`), so any change in
 * what is exchanged shows up in review. Key invariants are also asserted
 * explicitly, and the fake bearer and refresh tokens must never appear in
 * anything sent to MCP clients, Settings or the logs.
 *
 * `runServer` itself is not used here: its shutdown exits the process. The
 * connectors bench (`bun run bench:connectors --drive`) covers that path.
 */

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client"
import {
  createLifecycleHarness,
  findSecrets,
  type HandleTracker,
  Normalizer,
  trackHandles,
} from "@stuffbucket/maximal-plugin-host/testing"
import { createWorkIqPlugin } from "@stuffbucket/maximal-plugin-workiq"
import {
  elicitForm,
  fakeAuth,
  type FakeRemoteMcp,
  notifyProgress,
  startFakeWorkIq,
  WORKIQ_RESULTS,
  WORKIQ_TOOLS,
} from "@stuffbucket/maximal-plugin-workiq/testing"
import { afterAll, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { getConfig, writeConfig } from "~/lib/config/config"
import { PATHS } from "~/lib/platform/paths"
import { entryName } from "~/lib/plugins/clients/claude-code"
import { startPlugins, stopPlugins } from "~/lib/plugins/runtime"
import { setListeningPort } from "~/lib/start/proxy-port"
import { BUILD_VERSION } from "~/lib/update/build-info"
import { pluginMcpRoutes } from "~/routes/plugins/mcp"
import { server } from "~/server"

import { installFakeClaudeCli } from "./helpers/fake-claude-cli"
import {
  type ApiExchange,
  claudeMcpServers,
  configPlugins,
  listChangedAfter,
  isRecord,
  listChangedCount,
  openSse,
  readText,
  recordingTransport,
  type Run,
  settingsApi,
  settingsFile,
  step,
  textOf,
} from "./helpers/plugin-lifecycle"
import { serveApp } from "./helpers/plugins"

const ID = "workiq"
const hex = () => randomBytes(8).toString("hex")
const ACCESS_TOKEN = `e2e-access-${hex()}`
const REFRESH_TOKEN = `e2e-refresh-${hex()}`
const API_KEY = `e2e-key-${hex()}`
const SECRETS = [ACCESS_TOKEN, REFRESH_TOKEN]
const TOKEN_CACHE = "fake-token-cache.json"
const BROWSER_URL = "https://login.example.test/e2e/authorize"
const ACCOUNT = {
  username: "e2e@contoso.com",
  name: "E2E User",
  tenantId: "00000000-0000-4000-8000-0000000000e2",
}
/** Backoff and progress cadence: one "retrying" notice per throttled attempt. */
const RETRY_MS = 50
/** A server the user added to Claude Code themselves; Maximal never touches it. */
const USER_SERVER = { type: "http", url: "https://mcp.example.test/github" }
/** The user's own Work IQ, set up the way Microsoft's README shows. */
const USER_WORKIQ = {
  command: "npx",
  args: ["-y", "@microsoft/workiq@latest", "mcp"],
}
/** Maximal's entry name in Claude Code. */
const ENTRY = entryName(ID)
const ELICIT_SCHEMA = {
  type: "object" as const,
  properties: { mailbox: { type: "string" as const, title: "Mailbox" } },
  required: ["mailbox"],
}

const cleanups: Array<() => Promise<void> | void> = []
afterAll(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup()
    } catch {
      // Best effort; the test reports its own failures.
    }
  }
})

/** Connect the way Claude Code would: with the URL and headers of the entry
 *  Maximal wrote into its user config. */
async function connectClient(run: Run): Promise<Client> {
  const entry = claudeMcpServers(run)[ENTRY] as
    | { type: string; url: string; headers?: Record<string, string> }
    | undefined
  if (entry?.type !== "http") throw new Error("no Claude Code entry")
  const client = new Client(
    { name: "e2e-client", version: "1.0.0" },
    { capabilities: { elicitation: {} } },
  )
  client.setRequestHandler("elicitation/create", () =>
    Promise.resolve({
      action: "accept" as const,
      content: { mailbox: "shared@contoso.com" },
    }),
  )
  client.setNotificationHandler("notifications/tools/list_changed", () => {})
  const transport = new StreamableHTTPClientTransport(new URL(entry.url), {
    requestInit: { headers: entry.headers },
  })
  await client.connect(recordingTransport(transport, run.mcpLog))
  cleanups.push(() => client.close())
  return client
}

/** A fake Work IQ whose `ask` reports progress and asks the user a question. */
function startFake(): FakeRemoteMcp {
  const fake = startFakeWorkIq({ token: ACCESS_TOKEN })
  cleanups.push(() => fake.close())
  fake.handlers = {
    ask: async (args, ctx, meta) => {
      await notifyProgress(ctx, meta, {
        progress: 1,
        total: 2,
        message: "Searching mail",
      })
      const answer = await elicitForm(
        ctx,
        "Which mailbox should Work IQ search?",
        ELICIT_SCHEMA,
      )
      await notifyProgress(ctx, meta, {
        progress: 2,
        total: 2,
        message: "Summarising",
      })
      return {
        content: [
          {
            type: "text",
            text: `${String(args.question)} → ${answer.action}: ${String(answer.content?.mailbox)}`,
          },
        ],
      }
    },
  }
  return fake
}

/**
 * The real app on a loopback port around a harness-built host with the
 * Work IQ connector (fake upstream, fake sign-in with a token cache), and
 * `config.json` as an older Maximal left it: Work IQ off, its config still
 * in `plugins.workiq.config`. Plugins are not started yet.
 */
async function startRun(fake: FakeRemoteMcp): Promise<Run> {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-plugins-"))
  cleanups.push(() => fs.rmSync(storageRoot, { recursive: true, force: true }))
  const claude = startClaudeCode()
  const normalizer = new Normalizer({
    aliases: {
      [fake.origin]: "<upstream>",
      [API_KEY]: "<api-key>",
      [BUILD_VERSION]: "<version>",
      [claude.cli.binDir]: "<claude-bin>",
    },
    secrets: SECRETS,
  })
  const harness = createLifecycleHarness({
    plugins: [
      createWorkIqPlugin({
        endpoint: fake.url,
        auth: fakeAuth({
          account: ACCOUNT,
          token: ACCESS_TOKEN,
          cache: { file: TOKEN_CACHE, refreshToken: REFRESH_TOKEN },
          browserUrl: BROWSER_URL,
        }),
        retryDelaysMs: [RETRY_MS],
        random: () => 0.5,
        limits: { progressIntervalMs: RETRY_MS },
      }),
    ],
    storageRoot,
    normalizer,
    secrets: SECRETS,
  })
  cleanups.push(() => harness.dispose())
  writeConfig({
    plugins: { [ID]: { config: { endpoint: fake.url } } } as never,
    auth: {
      apiKeyEntries: [
        {
          id: "e2e",
          label: "e2e",
          key: API_KEY,
          enabled: true,
          created_at: new Date().toISOString(),
        },
      ],
    },
    // What an older Maximal recorded writing into Claude Code.
    apps: { claudeCode: { mcpServers: [ID] } },
  })
  cleanups.push(() => void writeConfig({}))
  const app = await serveApp(server.fetch)
  setListeningPort(Number(new URL(app.origin).port))
  normalizer.alias(app.origin, "<maximal>")
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await pluginMcpRoutes.closeAll()
    await stopPlugins()
    await app.close()
    setListeningPort(undefined)
  }
  cleanups.push(close)
  const apiLog: Array<ApiExchange> = []
  const sse = await openSse(`${app.origin}/settings/api/events`, API_KEY)
  cleanups.push(() => sse.close())
  return {
    id: ID,
    apiKey: API_KEY,
    bearer: ACCESS_TOKEN,
    harness,
    fake,
    normalizer,
    origin: app.origin,
    api: settingsApi(app.origin, API_KEY, apiLog),
    apiLog,
    mcpLog: [],
    sse,
    steps: [],
    views: new Map(),
    lastSse: undefined,
    closeApp: close,
    claude,
  }
}

/**
 * Claude Code installed but not routed through Maximal: the fake CLI first
 * on PATH, and a fresh `CLAUDE_CONFIG_DIR` whose user config has the user's
 * own MCP server and the `workiq` entry an older Maximal wrote (recorded in
 * `config.json`, see `startRun`).
 */
function startClaudeCode(): Run["claude"] {
  const cli = installFakeClaudeCli()
  cleanups.push(() => cli.dispose())
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-claude-config-"))
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = dir
  cleanups.push(() => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const configFile = path.join(dir, ".claude.json")
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      numStartups: 3,
      mcpServers: {
        github: USER_SERVER,
        [ID]: {
          type: "http",
          url: `http://127.0.0.1:4141/mcp/${ID}`,
          headers: { Authorization: "Bearer <sha256 placeholder>" },
        },
      },
    }),
  )
  return { cli, configFile }
}

/** Claude Code as Settings shows it on Work IQ. */
async function claudeCodeClient(run: Run): Promise<Record<string, unknown>> {
  const detail = await run.api("GET", `/plugins/${ID}`)
  const clients = (detail.response as { clients: Array<{ id: string }> })
    .clients
  const view = clients.find((client) => client.id === "claude-code")
  if (!view) throw new Error("no Claude Code client")
  return view
}

// ── Phases ─────────────────────────────────────────────────────────────

/** Boot, enable, terms, sign-in. Resolves the negotiated MCP version. */
async function bootAndSetUp(run: Run): Promise<string> {
  const { harness, fake } = run
  // 1. Boot: the legacy config value moves into settings.json, the old
  //    Claude Code entry is removed; Work IQ stays off.
  await step(run, "boot (an older Maximal's settings migrated)", async () => {
    await startPlugins({ gateway: harness.gateway })
    const list = await run.api("GET", "/plugins")
    expect(list.status).toBe(200)
    expect(harness.snapshot(ID).lifecycle).toBe("disabled")
    expect(harness.settings(ID)).toMatchObject({
      plugin: ID,
      version: 1,
      config: { endpoint: fake.url },
    })
    expect(configPlugins()).toEqual({ [ID]: {} })
    // The `workiq` entry an older Maximal wrote into Claude Code is gone,
    // and so is its record; the user's server stays.
    expect(claudeMcpServers(run)).toEqual({ github: USER_SERVER })
    expect(getConfig().apps?.claudeCode).not.toHaveProperty("mcpServers")
    const mcp = await fetch(`${run.origin}/mcp/${ID}`, {
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}` },
    })
    expect(mcp.status).toBe(404)
  })

  // 2. Enable → the terms gate.
  await step(run, "enable → terms-needed", async () => {
    const patched = await run.api("PATCH", `/plugins/${ID}`, { enabled: true })
    expect(patched.status).toBe(200)
    await harness.waitForStatus(ID, "terms-needed")
    expect(harness.fibers(ID)).toEqual([{ fiber: 1, state: "active" }])
    expect(harness.contributions(ID).actions.sort()).toEqual([
      "accept-terms",
      "retry",
      "sign-in",
      "sign-out",
    ])
  })

  // 3. Accept the terms → sign-in needed.
  await step(run, "accept-terms → signin-needed", async () => {
    expect(
      (await run.api("POST", `/plugins/${ID}/actions/accept-terms`)).status,
    ).toBe(202)
    await harness.waitForStatus(ID, "signin-needed")
    expect(harness.files(ID)).toContain("terms.json")
  })

  // 4. Sign in → ready.
  let protocol = ""
  await step(run, "sign-in → ready", async () => {
    expect(
      (await run.api("POST", `/plugins/${ID}/actions/sign-in`)).status,
    ).toBe(202)
    const status = await harness.waitForStatus(ID, "ready")
    expect(harness.opened).toEqual([BROWSER_URL])
    const facts = Object.fromEntries(
      (status?.facts ?? []).map((fact) => [fact.label, fact.value]),
    )
    expect(facts).toMatchObject({
      Account: ACCOUNT.username,
      Tenant: ACCOUNT.tenantId,
      Tools: String(WORKIQ_TOOLS.length),
    })
    expect(facts.Protocol).toMatch(/^MCP \d{4}-\d{2}-\d{2}$/)
    protocol = facts.Protocol.slice("MCP ".length)
    // The tokens live only in the connector's own storage.
    const cache =
      readText(path.join(harness.storageRoot, ID, TOKEN_CACHE)) ?? ""
    expect(cache).toContain(ACCESS_TOKEN)
    expect(cache).toContain(REFRESH_TOKEN)
    expect(harness.contributions(ID).tools).toEqual(
      WORKIQ_TOOLS.map((tool) => tool.name),
    )
  })

  await sendToClaudeCode(run)
  return protocol
}

/** Claude Code routed through Maximal, then Work IQ sent to it. */
async function sendToClaudeCode(run: Run) {
  // 5. Routing on: nothing is written for Work IQ until the user picks Claude Code.
  await step(run, "Claude Code routing on", async () => {
    const toggled = await run.api("POST", "/apps/claude-code/toggle", {
      enabled: true,
    })
    expect(toggled.status).toBe(200)
    expect(toggled.response).toMatchObject({ enabled: true, conflict: null })
    expect(claudeMcpServers(run)).toEqual({ github: USER_SERVER })
  })

  // 6. Work IQ → Claude Code: `maximal-workiq` with the real key; the user's
  //    server and the rest of the file untouched.
  const ours = () => ({
    type: "http",
    url: `${run.origin}/mcp/${ID}`,
    headers: { Authorization: `Bearer ${API_KEY}` },
  })
  await step(run, "send Work IQ to Claude Code", async () => {
    const patched = await run.api("PATCH", `/plugins/${ID}`, {
      clients: ["claude-code"],
    })
    expect(patched.status).toBe(200)
    expect(claudeMcpServers(run)).toEqual({
      github: USER_SERVER,
      [ENTRY]: ours(),
    })
    const document = JSON.parse(
      readText(run.claude.configFile) ?? "{}",
    ) as Record<string, unknown>
    expect(document.numStartups).toBe(3)
  })

  // 7. The user sets up Work IQ in Claude Code themselves: theirs wins,
  //    Maximal's entry goes, and Settings says why.
  await step(run, "user's own Work IQ takes precedence", async () => {
    writeClaudeServers(run, { ...claudeMcpServers(run), [ID]: USER_WORKIQ })
    expect(await claudeCodeClient(run)).toMatchObject({
      selected: true,
      available: true,
      standalone: { name: ID, source: "server" },
    })
    expect(claudeMcpServers(run)).toEqual({
      github: USER_SERVER,
      [ID]: USER_WORKIQ,
    })
  })

  // 8. They remove theirs: Maximal's comes back on the next look.
  await step(run, "user's own Work IQ removed", async () => {
    const { [ID]: _theirs, ...rest } = claudeMcpServers(run)
    writeClaudeServers(run, rest)
    expect(await claudeCodeClient(run)).not.toHaveProperty("standalone")
    expect(claudeMcpServers(run)).toEqual({
      github: USER_SERVER,
      [ENTRY]: ours(),
    })
  })
}

/** Edit Claude Code's user servers as the user (or Claude Code) would. */
function writeClaudeServers(run: Run, servers: Record<string, unknown>) {
  const document = JSON.parse(
    readText(run.claude.configFile) ?? "{}",
  ) as Record<string, unknown>
  fs.writeFileSync(
    run.claude.configFile,
    JSON.stringify({ ...document, mcpServers: servers }, null, 2),
  )
}

/** A real MCP client, the Settings detail, and blocking a tool. */
async function toolsAndPermissions(run: Run): Promise<Client> {
  const { harness, fake } = run
  // 9. A real MCP client sees the upstream tools, verbatim.
  let client: Client | undefined
  await step(run, "MCP client: tools mirrored", async () => {
    client = await connectClient(run)
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toEqual(
      WORKIQ_TOOLS.map((tool) => tool.name),
    )
    for (const upstream of WORKIQ_TOOLS) {
      const mirrored = tools.find((tool) => tool.name === upstream.name)
      expect({
        name: mirrored?.name,
        title: mirrored?.title,
        description: mirrored?.description,
        inputSchema: mirrored?.inputSchema,
        outputSchema: mirrored?.outputSchema,
        annotations: mirrored?.annotations,
      }).toEqual({
        name: upstream.name,
        title: upstream.title,
        description: upstream.description,
        inputSchema: upstream.inputSchema,
        outputSchema: upstream.outputSchema,
        annotations: upstream.annotations,
      })
    }
  })
  if (!client) throw new Error("no MCP client")
  const mcp = client

  // 10. Settings detail: groups, permission sources.
  await step(run, "Settings detail view", async () => {
    const detail = await run.api("GET", `/plugins/${ID}`)
    expect(detail.status).toBe(200)
    const view = detail.response as {
      toolCounts: { total: number; byGroup: Record<string, number> }
      toolsSource: string
      tools: Array<{ name: string; permissionSource?: string }>
      manifest: { connector?: Record<string, unknown> }
    }
    expect(view.toolCounts).toEqual({
      total: 14,
      byGroup: { "read-only": 6, "write-delete": 5, other: 3 },
    })
    expect(view.toolsSource).toBe("live")
    expect(new Set(view.tools.map((tool) => tool.permissionSource))).toEqual(
      new Set(["default"]),
    )
    // Only the auth type leaves the server: no client id, authority or scopes.
    expect(view.manifest.connector?.auth).toEqual({ type: "entra" })
  })

  // 11. Block a tool: hidden from MCP, calls refused, upstream never asked.
  await step(run, "block delete_entity", async () => {
    const since = listChangedCount(run.mcpLog)
    const put = await run.api("PUT", `/plugins/${ID}/tool-permissions`, {
      permissions: { delete_entity: "block" },
    })
    expect(put.status).toBe(200)
    await listChangedAfter(run, since)
    const { tools } = await mcp.listTools()
    expect(tools.map((tool) => tool.name)).not.toContain("delete_entity")
    const calls = fake.calls().length
    const refused = await mcp.callTool({
      name: "delete_entity",
      arguments: { path: "/me/messages/1" },
    })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toBe("This tool is blocked in Maximal settings.")
    expect(fake.calls().length).toBe(calls)
    expect(harness.settings(ID)).toMatchObject({
      tools: { permissions: { delete_entity: "block" } },
    })
  })
  await step(run, "unblock delete_entity", async () => {
    const since = listChangedCount(run.mcpLog)
    const put = await run.api("PUT", `/plugins/${ID}/tool-permissions`, {
      permissions: { delete_entity: null },
    })
    expect(put.status).toBe(200)
    await listChangedAfter(run, since)
    const { tools } = await mcp.listTools()
    expect(tools.map((tool) => tool.name)).toContain("delete_entity")
  })

  return mcp
}

/** Calls: exact upstream request, relays, retry on throttling, a policy denial. */
async function toolCalls(run: Run, mcp: Client, protocol: string) {
  const { harness, fake } = run
  // 12. An allowed call: exactly what goes upstream and what comes back.
  await step(run, "call retrieve", async () => {
    const mark = fake.requests.length
    const args = { query: "Q3 plan", sources: ["teams", "mail"], top: 3 }
    const result = await mcp.callTool({ name: "retrieve", arguments: args })
    const canned = WORKIQ_RESULTS.retrieve
    expect(result).toEqual(typeof canned === "function" ? canned(args) : canned)
    expect(fake.calls().at(-1)).toEqual({ name: "retrieve", args })
    const sent = fake.requests
      .slice(mark)
      .filter((request) => request.rpc === "tools/call")
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      authorization: `Bearer ${ACCESS_TOKEN}`,
      protocolVersion: protocol,
      tool: "retrieve",
      status: 200,
    })
    // Inside the upstream session (after the `server/discover` probe and
    // the `initialize` handshake) every request names the negotiated version.
    const inSession = fake.requests
      .slice(mark)
      .filter((request) => request.sessionId !== null)
    expect(inSession.length).toBeGreaterThan(0)
    for (const request of inSession)
      expect(request.protocolVersion).toBe(protocol)
  })

  // 13. Progress and elicitation relayed both ways.
  await step(run, "ask: progress + elicitation round trip", async () => {
    const progress: Array<{ progress: number; message?: string }> = []
    const result = await mcp.callTool(
      { name: "ask", arguments: { question: "What's new?" } },
      { onprogress: (update) => progress.push(update) },
    )
    expect(textOf(result)).toBe("What's new? → accept: shared@contoso.com")
    expect(progress.map((update) => update.message)).toEqual([
      "Searching mail",
      "Summarising",
    ])
    const elicitation = run.mcpLog.find(
      (entry) =>
        entry.dir === "receive"
        && isRecord(entry.message)
        && entry.message.method === "elicitation/create",
    )
    expect(elicitation?.message).toMatchObject({
      params: {
        message: "Which mailbox should Work IQ search?",
        requestedSchema: ELICIT_SCHEMA,
      },
    })
  })

  // 14. A throttled result is retried; the wait shows as progress.
  await step(run, "retrieve: result-level 429 then success", async () => {
    const throttled = fake.throttled
    fake.throttle({ mode: "result", tool: "retrieve" })
    const progress: Array<{ message?: string }> = []
    const args = { query: "budget" }
    const result = await mcp.callTool(
      { name: "retrieve", arguments: args },
      { onprogress: (update) => progress.push(update) },
    )
    expect(result.isError).toBeFalsy()
    expect(fake.throttled).toBe(throttled + 1)
    expect(
      fake
        .calls()
        .slice(-2)
        .map((call) => call.args),
    ).toEqual([args, args])
    expect(progress).toHaveLength(1)
    expect(progress[0].message).toMatch(
      /^Work IQ is rate-limiting requests \(HTTP 429\); retrying in \d+ s\.$/,
    )
  })

  // 15. A policy 403 fails that call only.
  await step(run, "retrieve: policy 403 isolated", async () => {
    fake.fail({
      status: 403,
      rpc: "tools/call",
      body: '{"error":{"code":"Forbidden","message":"Access denied by policy"}}',
    })
    const denied = await mcp.callTool({
      name: "retrieve",
      arguments: { query: "salaries" },
    })
    expect(denied.isError).toBe(true)
    expect(harness.snapshot(ID).status?.code).toBe("ready")
    const after = await mcp.callTool({
      name: "retrieve",
      arguments: { query: "again" },
    })
    expect(after.isError).toBeFalsy()
  })
}

/** Config changes through Settings, then sign-out. */
async function configAndSignOut(run: Run, mcp: Client) {
  const { harness, fake } = run
  // 16. Config changes through Settings.
  await step(run, "PATCH invalid config → 400, nothing reloads", async () => {
    const settingsBefore = harness.settingsText(ID)
    const mark = harness.mark()
    const rejected = await run.api("PATCH", `/plugins/${ID}`, {
      config: { endpoint: "https://attacker.example.com/mcp" },
    })
    expect(rejected.status).toBe(400)
    const issues = (rejected.response as { issues: Array<{ path: string }> })
      .issues
    expect(issues.map((issue) => issue.path)).toEqual(["config.endpoint"])
    await harness.flush()
    expect(harness.transcript({ since: mark, kinds: ["fiber"] })).toEqual([])
    expect(harness.settingsText(ID)).toBe(settingsBefore)
  })
  await step(run, "PATCH valid config → reload → ready again", async () => {
    const since = listChangedCount(run.mcpLog)
    const patched = await run.api("PATCH", `/plugins/${ID}`, {
      config: {
        endpoint: fake.url,
        authority: "https://login.microsoft.com/organizations",
      },
    })
    expect(patched.status).toBe(200)
    expect(harness.fibers(ID)).toEqual([
      { fiber: 1, state: "disposed" },
      { fiber: 2, state: "active" },
    ])
    await harness.waitForStatus(ID, "ready")
    await listChangedAfter(run, since)
    const { tools } = await mcp.listTools()
    expect(tools).toHaveLength(WORKIQ_TOOLS.length)
  })

  // 17. Sign out: tools gone, token cache removed, upstream sessions closed.
  await step(run, "sign-out → signin-needed", async () => {
    const since = listChangedCount(run.mcpLog)
    expect(
      (await run.api("POST", `/plugins/${ID}/actions/sign-out`)).status,
    ).toBe(202)
    await harness.waitForStatus(ID, "signin-needed")
    await listChangedAfter(run, since)
    expect((await mcp.listTools()).tools).toEqual([])
    expect(harness.files(ID)).not.toContain(TOKEN_CACHE)
    await harness.waitFor(() => fake.sessionCount === 0, {
      message: `${fake.sessionCount} upstream sessions still open`,
    })
    const detail = await run.api("GET", `/plugins/${ID}`)
    expect((detail.response as { toolsSource: string }).toolsSource).toBe(
      "cache",
    )
  })
}

/** Disable, then shut everything down and check nothing is left. */
async function disableAndShutDown(
  run: Run,
  mcp: Client,
  tracker: HandleTracker,
) {
  const { harness, fake } = run
  // 18. Disable: the endpoint disappears.
  await step(run, "disable → MCP 404", async () => {
    const patched = await run.api("PATCH", `/plugins/${ID}`, {
      enabled: false,
    })
    expect(patched.status).toBe(200)
    expect(harness.snapshot(ID).lifecycle).toBe("disabled")
    expect(harness.contributions(ID)).toEqual({
      attached: false,
      tools: [],
      actions: [],
      status: undefined,
    })
    const response = await fetch(`${run.origin}/mcp/${ID}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    })
    expect(response.status).toBe(404)
    expect(
      ((await response.json()) as { error: { code: string } }).error.code,
    ).toBe("MCP_ENDPOINT_NOT_FOUND")
    expect(pluginMcpRoutes.sessionCount(ID)).toBe(0)
    // Claude Code loses the entry Maximal wrote, and only that one.
    expect(claudeMcpServers(run)).toEqual({ github: USER_SERVER })
  })

  // 19. Shutdown: nothing left open, anywhere.
  await mcp.close().catch(() => undefined)
  await run.sse.close()
  await run.closeApp()
  await harness.dispose()
  expect(fake.sessionCount).toBe(0)
  await harness
    .waitFor(() => tracker.live().length === 0, { timeoutMs: 2000 })
    .catch(() => undefined)
  expect(
    tracker
      .live()
      .map(
        (handle) => `${handle.kind} ${handle.detail} ${handle.stack[0] ?? ""}`,
      ),
  ).toEqual([])
}

// ── The test ───────────────────────────────────────────────────────────

test("Work IQ end to end: boot → setup → tools → calls → config → sign-out → disable → shutdown", async () => {
  const fake = startFake()
  const tracker = trackHandles()
  cleanups.push(() => tracker.stop())
  const run = await startRun(fake)

  const protocol = await bootAndSetUp(run)
  const mcp = await toolsAndPermissions(run)
  await toolCalls(run, mcp, protocol)
  await configAndSignOut(run, mcp)
  await disableAndShutDown(run, mcp, tracker)
  tracker.stop()

  // Secrets never left the connector's storage.
  const outward = {
    mcp: run.mcpLog,
    sse: run.sse.frames,
    api: run.apiLog.map((exchange) => exchange.text),
    config: readText(PATHS.CONFIG_PATH),
    settings: readText(settingsFile(run)),
    claudeCode: readText(run.claude.configFile),
  }
  expect(findSecrets(outward, SECRETS)).toEqual([])
  expect(run.harness.secretsSeen()).toEqual([])

  // The whole exchange, normalised.
  expect(run.steps).toMatchSnapshot()
}, 60_000)
