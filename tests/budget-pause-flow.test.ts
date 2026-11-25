/**
 * A request held at a pause rule, end to end on the real runtime, config and
 * usage store: held until the limit clears, resumed, cancelled, timed out,
 * abandoned and capped, and what the person is told.
 */

import { describe, expect, test } from "bun:test"

import { getPauseGate } from "~/lib/budget/runtime"
import { getConfig, writeConfig } from "~/lib/config/config"
import { settingsEventBus } from "~/lib/config/settings-events"
import {
  BudgetStatusResponse,
  PluginsAttentionResponse,
} from "~/lib/config/settings-types"
import { takePluginNotices } from "~/lib/plugins/notices"

import { AIU } from "./helpers/budget-service-harness"
import {
  chatApp,
  post,
  putRule,
  send,
  spend,
  status,
  until,
  useFlowHooks,
} from "./helpers/pause-flow"

useFlowHooks()

describe("a held request that doesn't stream", () => {
  test("passes straight through while the rule has room, or none pauses", async () => {
    const route = chatApp("openai")
    expect((await post(route, { model: "m" })).status).toBe(200)
    await putRule()
    expect((await post(route, { model: "m" })).status).toBe(200)
    await putRule({ action: "block" })
    spend(2 * AIU)
    // A block rule refuses at once, as before.
    expect((await post(route, { model: "m" })).status).toBe(402)
  })

  test("is held at the limit, counted, and let through once the limit is raised", async () => {
    await putRule()
    spend(2 * AIU)
    const route = chatApp("openai")
    const pending = post(route, { model: "m" })
    await until(() => getPauseGate().heldCount("agents") === 1)
    expect((await status()).budgets[0].paused).toBe(1)

    await putRule({ limit: 10 * AIU })
    const response = await pending
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(getPauseGate().heldCount()).toBe(0)
    expect((await status()).budgets[0].paused).toBe(0)
  })

  test("raises a notice and an entry with the rule's four choices", async () => {
    await putRule()
    spend(2 * AIU)
    const pending = post(chatApp("openai"), { model: "m" })
    await until(() => getPauseGate().heldCount("agents") === 1)

    const notices = takePluginNotices()
    expect(notices.map((n) => n.code)).toEqual(["rule-paused"])
    expect(notices[0].message).toStartWith('Paused 1 request: rule "Agents"')
    const attention = PluginsAttentionResponse.parse(
      await (await send("GET", "/plugins/attention")).json(),
    ).attention
    expect(attention[0].actions.map((a) => a.id)).toEqual([
      "resume-once.pause.agents",
      "allow-more.pause.agents",
      "resume-reset.pause.agents",
      "cancel.pause.agents",
    ])
    await send("POST", "/plugins/budget/actions/cancel.pause.agents")
    expect((await pending).status).toBe(402)
  })

  test("Resume once lets it through though the limit is still reached", async () => {
    await putRule()
    spend(2 * AIU)
    const pending = post(chatApp("openai"), { model: "m" })
    await until(() => getPauseGate().heldCount("agents") === 1)

    const run = await send(
      "POST",
      "/plugins/budget/actions/resume-once.pause.agents",
    )
    expect(run.status).toBe(202)
    expect((await pending).status).toBe(200)
    // The limit was not changed: the next request is held again.
    const next = post(chatApp("openai"), { model: "m" })
    await until(() => getPauseGate().heldCount("agents") === 1)
    getPauseGate().cancel()
    expect((await next).status).toBe(402)
  })

  test("the API's resume and reset choices do the same", async () => {
    await putRule()
    spend(2 * AIU)
    const first = post(chatApp("openai"), { model: "m" })
    await until(() => getPauseGate().heldCount("agents") === 1)
    const resumed = await send("POST", "/budget/limits/agents/approve", {
      choice: "resume",
    })
    expect(resumed.status).toBe(200)
    expect((await first).status).toBe(200)

    const second = post(chatApp("openai"), { model: "m" })
    await until(() => getPauseGate().heldCount("agents") === 1)
    const reset = await send("POST", "/budget/limits/agents/approve", {
      choice: "reset",
    })
    const body = BudgetStatusResponse.parse(await reset.json())
    expect(body.budgets[0].overrides[0].kind).toBe("unlimited")
    // Until the day's reset.
    expect(body.budgets[0].overrides[0].expires_at).toMatch(/T00:00:00\.000Z$/u)
    expect((await second).status).toBe(200)
  })

  test("Allow more wakes it, and it passes once there is room", async () => {
    await putRule({ limit: 2 * AIU })
    spend(2 * AIU)
    const pending = post(chatApp("openai"), { model: "m" })
    await until(() => getPauseGate().heldCount("agents") === 1)
    await send("POST", "/plugins/budget/actions/allow-more.pause.agents")
    expect((await pending).status).toBe(200)
  })

  test("resuming with nothing held is a 409; so is cancelling", async () => {
    await putRule()
    const resume = await send("POST", "/budget/limits/agents/approve", {
      choice: "resume",
    })
    expect(resume.status).toBe(409)
    expect(
      ((await resume.json()) as { error: { type: string } }).error.type,
    ).toBe("nothing_paused")
    const cancel = await send("DELETE", "/budget/limits/agents/paused")
    expect(cancel.status).toBe(409)
    expect((await send("DELETE", "/budget/limits/ghost/paused")).status).toBe(
      404,
    )
    expect((await send("DELETE", "/budget/limits/Bad Id/paused")).status).toBe(
      400,
    )
  })
})

describe("a held request that ends without a reply", () => {
  test("cancelling the held requests fails them with the usual 402", async () => {
    await putRule()
    spend(2 * AIU)
    const route = chatApp("anthropic")
    const pending = [post(route, { model: "m" }), post(route, { model: "m" })]
    await until(() => getPauseGate().heldCount("agents") === 2)

    const cancel = await send("DELETE", "/budget/limits/agents/paused")
    expect(cancel.status).toBe(200)
    for (const response of await Promise.all(pending)) {
      expect(response.status).toBe(402)
      const body = (await response.json()) as {
        type: string
        error: { type: string }
      }
      expect(body.error.type).toBe("billing_error")
    }
    expect(getPauseGate().heldCount()).toBe(0)
  })

  test("a request that waits the maximum is refused with the usual 402", async () => {
    writeConfig({ budget: { pause: { maxWaitSeconds: 1 } } })
    await putRule()
    spend(2 * AIU)
    const started = Date.now()
    const response = await post(chatApp("openai"), { model: "m" })
    expect(response.status).toBe(402)
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe("budget_exceeded")
    expect(getPauseGate().heldCount()).toBe(0)
  })

  test("a client that disconnects frees its slot", async () => {
    await putRule()
    spend(2 * AIU)
    const gone = new AbortController()
    const pending = post(chatApp("openai"), { model: "m" }, gone.signal)
    await until(() => getPauseGate().heldCount("agents") === 1)
    gone.abort()
    await until(() => getPauseGate().heldCount() === 0)
    await Promise.resolve(pending).catch(() => undefined)
  })

  test("only so many are held; the next is refused and says why", async () => {
    writeConfig({ budget: { pause: { maxHeld: 2 } } })
    await putRule()
    spend(2 * AIU)
    const route = chatApp("openai")
    const held = [post(route, { model: "m" }), post(route, { model: "m" })]
    await until(() => getPauseGate().heldCount("agents") === 2)

    const refused = await post(route, { model: "m" })
    expect(refused.status).toBe(402)
    const body = (await refused.json()) as { error: { message: string } }
    expect(body.error.message).toContain(
      "Too many requests are already paused.",
    )
    expect(getPauseGate().heldCount()).toBe(2)
    getPauseGate().cancel()
    await Promise.all(held)
  })

  test("a rule that stops pausing while it waits refuses it", async () => {
    await putRule()
    spend(2 * AIU)
    const pending = post(chatApp("openai"), { model: "m" })
    await until(() => getPauseGate().heldCount("agents") === 1)
    await putRule({ action: "block" })
    expect((await pending).status).toBe(402)
  })

  test("a malformed body goes to the handler", async () => {
    await putRule()
    const route = chatApp("openai")
    const response = await route.request("/", {
      method: "POST",
      body: "not json",
    })
    expect(response.status).toBe(500)
    expect(getPauseGate().heldCount()).toBe(0)
  })

  test("telling the shell: pausing and resuming push the status", async () => {
    await putRule()
    spend(2 * AIU)
    const seen: Array<number> = []
    const stop = settingsEventBus.subscribe("budget.changed", (next) => {
      seen.push(next.budgets[0]?.paused ?? -1)
    })
    try {
      const pending = post(chatApp("openai"), { model: "m" })
      await until(() => getPauseGate().heldCount("agents") === 1)
      await Bun.sleep(30)
      getPauseGate().resume()
      await pending
      await until(() => getPauseGate().heldCount() === 0)
      await Bun.sleep(30)
    } finally {
      stop()
    }
    expect(seen).toContain(1)
    expect(seen.at(-1)).toBe(0)
  })

  test("a budget that is off holds nothing", async () => {
    await putRule()
    spend(2 * AIU)
    await send("PATCH", "/budget", { enabled: false })
    expect((await post(chatApp("openai"), { model: "m" })).status).toBe(200)
    expect(getConfig().budget?.enabled).toBe(false)
  })
})
