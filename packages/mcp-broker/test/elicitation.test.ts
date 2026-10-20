import {
  Client,
  type ElicitRequestFormParams,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client"
import { afterEach, describe, expect, it } from "bun:test"
import { resolve } from "node:path"

import {
  type RunningBrokerServer,
  startBrokerServer,
} from "../src/broker-server.ts"
import {
  type AskMaximal,
  type MaximalElicitation,
  asksForSensitiveData,
  chooseElicitationAction,
  classifyElicitation,
  policyCanElicit,
} from "../src/elicitation.ts"
import { MaximalElicitations } from "../src/maximal-elicitations.ts"
import {
  BrokerWireConfigurationSchema,
  ElicitationPolicySchema,
} from "../src/wire-config.ts"

const API_KEY = "elicitation-test-key-that-is-longer-than-32-bytes"
const fixturePath = resolve(import.meta.dir, "fixture.ts")
const runningServers: Array<RunningBrokerServer> = []
const openClients: Array<Client> = []

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()))
  await Promise.all(runningServers.splice(0).map((server) => server.close()))
})

const policy = (value: Record<string, unknown> = {}) =>
  ElicitationPolicySchema.parse(value)

/** A form as a server sends it; properties are loose so tests can use any. */
const form = (
  properties: Record<string, Record<string, unknown>>,
): ElicitRequestFormParams =>
  ({
    message: "m",
    requestedSchema: { type: "object", properties },
  }) as ElicitRequestFormParams

describe("routing", () => {
  it("classifies forms and URLs", () => {
    expect(
      classifyElicitation(
        form({
          a: { type: "boolean" },
          b: { type: "string", enum: ["x"] },
          c: { type: "integer" },
          d: { type: "array", items: { type: "string", enum: ["x"] } },
        }),
        "legacy",
      ),
    ).toEqual({
      mode: "form",
      mechanism: "legacy-form",
      fieldTypes: ["boolean", "enum", "integer", "unsupported"],
      propertyCount: 4,
    })
    expect(
      classifyElicitation(
        {
          mode: "url",
          message: "m",
          url: "https://Login.Example/x",
          elicitationId: "e",
        },
        "modern",
      ),
    ).toMatchObject({
      mode: "url",
      mechanism: "modern-input-required",
      urlHost: "login.example",
    })
  })

  it("uses the first matching rule, else the default", () => {
    const rules = policy({
      defaultAction: "maximal",
      rules: [
        { match: { toolNames: ["get_debug_link"] }, action: "deny" },
        {
          match: { modes: ["url"], urlHosts: ["login.example"] },
          action: "passthrough",
        },
        {
          match: { fieldTypes: ["boolean"], maxProperties: 1 },
          action: "passthrough",
        },
      ],
    })
    const booleanForm = classifyElicitation(
      form({ ok: { type: "boolean" } }),
      "legacy",
    )
    const url = classifyElicitation(
      {
        mode: "url",
        message: "m",
        url: "https://login.example/",
        elicitationId: "e",
      },
      "legacy",
    )

    expect(chooseElicitationAction(rules, booleanForm, "get_debug_link")).toBe(
      "deny",
    )
    expect(chooseElicitationAction(rules, booleanForm, "other")).toBe(
      "passthrough",
    )
    expect(chooseElicitationAction(rules, url)).toBe("passthrough")
    // A rule naming a tool doesn't match when the tool is unknown.
    expect(
      chooseElicitationAction(
        rules,
        classifyElicitation(form({ s: { type: "string" } }), "legacy"),
      ),
    ).toBe("maximal")
  })

  it("advertises support only when someone could be asked", () => {
    expect(policyCanElicit(policy())).toBe(true)
    expect(policyCanElicit(policy({ defaultAction: "deny" }))).toBe(false)
    expect(
      policyCanElicit(
        policy({
          defaultAction: "deny",
          rules: [{ match: { modes: ["form"] }, action: "maximal" }],
        }),
      ),
    ).toBe(true)
  })

  it("spots forms asking for credentials or payment details", () => {
    expect(asksForSensitiveData(form({ password: { type: "string" } }))).toBe(
      true,
    )
    expect(
      asksForSensitiveData(
        form({ x: { type: "string", title: "Card number" } }),
      ),
    ).toBe(true)
    expect(asksForSensitiveData(form({ note: { type: "string" } }))).toBe(false)
  })
})

const startFixtureBroker = async (
  elicitation: Record<string, unknown> = {},
  askMaximal?: AskMaximal,
): Promise<RunningBrokerServer> => {
  const server = await startBrokerServer(
    BrokerWireConfigurationSchema.parse({
      endpoints: [
        {
          id: "fixture",
          label: "Fixture",
          command: process.execPath,
          args: [fixturePath, "--era", "legacy"],
          protocol: "legacy",
          ownership: "exclusive",
          elicitation,
        },
      ],
    }),
    API_KEY,
    askMaximal ? { askMaximal } : {},
  )
  runningServers.push(server)
  return server
}

/** A session client; `onElicit` makes it one that can show requests itself. */
const connect = async (
  server: RunningBrokerServer,
  onElicit?: (params: unknown) => Record<string, unknown>,
): Promise<Client> => {
  const client = new Client(
    { name: "elicitation-test-client", version: "0.0.0" },
    {
      capabilities: onElicit ? { elicitation: { form: {}, url: {} } } : {},
      versionNegotiation: { mode: "legacy" },
    },
  )
  if (onElicit) {
    client.setRequestHandler("elicitation/create", (request) =>
      Promise.resolve(onElicit(request.params) as never),
    )
  }
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://${server.host}:${server.port}/mcp/fixture`),
      { requestInit: { headers: { Authorization: `Bearer ${API_KEY}` } } },
    ),
    { timeout: 10_000 },
  )
  openClients.push(client)
  return client
}

const callText = async (client: Client, name: string): Promise<string> => {
  const result = await client.callTool({ name, arguments: {} })
  const [content] = result.content as Array<{ text: string }>
  return content.text
}

/** A fake Maximal that records what it is asked and answers with `answer`. */
const fakeMaximal = (
  answer: (request: MaximalElicitation) => Record<string, unknown> | undefined,
) => {
  const asked: Array<MaximalElicitation> = []
  const withdrawn: Array<MaximalElicitation> = []
  const ask: AskMaximal = (request, signal) => {
    asked.push(request)
    const result = answer(request)
    if (result) return Promise.resolve(result as never)
    return new Promise((resolve) => {
      signal.addEventListener("abort", () => {
        withdrawn.push(request)
        resolve({ action: "cancel" })
      })
    })
  }
  return { ask, asked, withdrawn }
}

describe("requests for user input through the broker", () => {
  it("asks Maximal when the client can't show forms", async () => {
    const maximal = fakeMaximal(() => ({
      action: "accept",
      content: { confirmed: true },
    }))
    const client = await connect(await startFixtureBroker({}, maximal.ask))

    expect(await callText(client, "interactive_one")).toBe(
      "terminal:accept:rounds:1",
    )
    expect(maximal.asked).toHaveLength(1)
    expect(maximal.asked[0]).toMatchObject({
      endpointId: "fixture",
      label: "Fixture",
      toolName: "interactive_one",
      mechanism: "legacy-form",
      mode: "form",
      message: "Confirm the first legacy fixture round.",
    })
    expect(maximal.asked[0]?.expiresAtMs).toBeGreaterThan(Date.now())
  })

  it("returns Maximal's answer to the server verbatim", async () => {
    const content = { confirmed: true, note: "hi", count: 3, color: "blue" }
    const maximal = fakeMaximal(() => ({ action: "accept", content }))
    const client = await connect(await startFixtureBroker({}, maximal.ask))

    expect(await callText(client, "interactive_echo")).toBe(
      `terminal:accept:${JSON.stringify(content)}`,
    )
  })

  it("passes the request through to a client that can show it", async () => {
    const maximal = fakeMaximal(() => ({ action: "decline" }))
    const shown: Array<unknown> = []
    const client = await connect(
      await startFixtureBroker({}, maximal.ask),
      (params) => {
        shown.push(params)
        return { action: "accept", content: { confirmed: true } }
      },
    )

    expect(await callText(client, "interactive_one")).toBe(
      "terminal:accept:rounds:1",
    )
    expect(shown).toHaveLength(1)
    expect(maximal.asked).toHaveLength(0)
  })

  it("follows the policy over what the client can do", async () => {
    const maximal = fakeMaximal(() => ({ action: "decline" }))
    const shown: Array<unknown> = []
    const client = await connect(
      await startFixtureBroker({ defaultAction: "maximal" }, maximal.ask),
      (params) => {
        shown.push(params)
        return { action: "accept" }
      },
    )

    expect(await callText(client, "interactive_one")).toBe(
      "terminal:decline:rounds:1",
    )
    expect(shown).toHaveLength(0)
    expect(maximal.asked).toHaveLength(1)
  })

  it("declines without asking when the policy denies", async () => {
    const maximal = fakeMaximal(() => ({ action: "accept" }))
    const client = await connect(
      await startFixtureBroker(
        {
          rules: [
            { match: { toolNames: ["interactive_one"] }, action: "deny" },
          ],
        },
        maximal.ask,
      ),
    )

    expect(await callText(client, "interactive_one")).toBe(
      "terminal:decline:rounds:1",
    )
    expect(maximal.asked).toHaveLength(0)
  })

  it("routes URL requests and declines credential forms", async () => {
    const maximal = fakeMaximal(() => ({ action: "accept" }))
    const client = await connect(await startFixtureBroker({}, maximal.ask))

    expect(await callText(client, "interactive_url")).toBe("terminal:accept")
    expect(maximal.asked[0]).toMatchObject({
      mode: "url",
      mechanism: "legacy-url",
      url: "https://fixture.example/consent",
    })

    expect(await callText(client, "interactive_sensitive")).toBe(
      "terminal:decline",
    )
    expect(maximal.asked).toHaveLength(1)
  })

  it("declines when nobody can show the request", async () => {
    const client = await connect(await startFixtureBroker())

    expect(await callText(client, "interactive_one")).toBe(
      "terminal:decline:rounds:1",
    )
  })

  it("cancels and withdraws a request nobody answers in time", async () => {
    const maximal = fakeMaximal(() => undefined)
    const client = await connect(
      await startFixtureBroker({ timeoutMs: 300 }, maximal.ask),
    )

    expect(await callText(client, "interactive_one")).toBe(
      "terminal:cancel:rounds:1",
    )
    expect(maximal.withdrawn).toHaveLength(1)
  })

  it("withdraws a waiting request when its session closes", async () => {
    const maximal = fakeMaximal(() => undefined)
    const client = await connect(await startFixtureBroker({}, maximal.ask))

    const call = client
      .callTool({ name: "interactive_one", arguments: {} })
      .catch(() => undefined)
    for (
      let attempt = 0;
      attempt < 50 && maximal.asked.length === 0;
      attempt += 1
    ) {
      await Bun.sleep(100)
    }
    expect(maximal.asked).toHaveLength(1)

    const transport = client.transport as StreamableHTTPClientTransport
    await transport.terminateSession()
    await client.close()
    await call
    for (
      let attempt = 0;
      attempt < 50 && maximal.withdrawn.length === 0;
      attempt += 1
    ) {
      await Bun.sleep(100)
    }
    expect(maximal.withdrawn).toHaveLength(1)
  })
})

describe("asking Maximal over the control channel", () => {
  const request: MaximalElicitation = {
    endpointId: "fixture",
    label: "Fixture",
    mechanism: "legacy-form",
    mode: "form",
    message: "m",
    expiresAtMs: Date.now() + 60_000,
  }

  it("sends elicit and resolves with the matching result", async () => {
    const sent: Array<{ operation: string; requestId: string }> = []
    const elicitations = new MaximalElicitations((frame) => {
      sent.push(frame)
      return Promise.resolve()
    })

    const answer = elicitations.ask(request, new AbortController().signal)
    await Bun.sleep(0)
    expect(sent).toHaveLength(1)
    const [frame] = sent
    expect(frame.operation).toBe("elicit")

    elicitations.settle("elicit-unknown", { action: "accept" })
    elicitations.settle(frame.requestId, { action: "decline" })
    expect(await answer).toEqual({ action: "decline" })
    expect(elicitations.size).toBe(0)
  })

  it("withdraws on abort and cancels everything on stop", async () => {
    const sent: Array<{ operation: string; requestId: string }> = []
    const elicitations = new MaximalElicitations((frame) => {
      sent.push(frame)
      return Promise.resolve()
    })

    const aborter = new AbortController()
    const first = elicitations.ask(request, aborter.signal)
    const second = elicitations.ask(request, new AbortController().signal)
    aborter.abort()
    expect(await first).toEqual({ action: "cancel" })
    expect(sent.map((frame) => frame.operation)).toContain("elicitWithdrawn")

    elicitations.cancelAll()
    expect(await second).toEqual({ action: "cancel" })
  })
})
