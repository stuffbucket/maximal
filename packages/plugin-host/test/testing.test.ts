/**
 * The lifecycle harness and conformance suite (`../src/testing`): the echo
 * fixture through the suite, a migrating variant of it, and the harness's
 * own signals — a recorded transcript, and the leak and tampering checks
 * catching plugins that misbehave.
 */
import type { PluginModule } from "@stuffbucket/maximal-plugin-sdk"

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { z } from "zod"

import {
  createLifecycleHarness,
  type LifecycleHarness,
  runPluginConformance,
  trackHandles,
} from "../src/testing"
import * as echo from "./fixtures/echo"
import { define } from "./helpers"

runPluginConformance(echo, { changedConfig: { prefix: "changed" } })

/** `plugin` at settings version 2: v1 stored `{ text }`, v2 calls it `prefix`. */
function atVersion2(plugin: PluginModule): PluginModule {
  return {
    ...plugin,
    manifest: { ...plugin.manifest, settingsVersion: 2 },
    migrateSettings(fromVersion, config) {
      if (fromVersion !== 1) return config
      const { text } = (config ?? {}) as { text?: string }
      return text === undefined ? {} : { prefix: text }
    },
  }
}

const echoV2 = atVersion2(echo)

runPluginConformance(echoV2, {
  title: "plugin conformance: echo (settings version 2)",
  migration: {
    fromVersion: 1,
    config: { text: "old" },
    expected: { prefix: "old" },
  },
})

let harness: LifecycleHarness | undefined
afterEach(async () => {
  const current = harness
  harness = undefined
  await current?.dispose()
})

describe("createLifecycleHarness", () => {
  test("records what crosses the plugin boundary, in order", async () => {
    harness = createLifecycleHarness({ plugins: [echo] })
    harness.step("enable")
    await harness.enable("echo")
    await harness.flush()
    harness.step("call")
    expect(
      await harness.gateway.callTool(
        "echo",
        "echo",
        { text: "hi" },
        {
          signal: new AbortController().signal,
        },
      ),
    ).toEqual({ content: [{ type: "text", text: "echo: hi" }] })
    await harness.flush()
    harness.step("block")
    await harness.setPermissions("echo", { echo: "block" })
    await harness.flush()
    harness.step("reload")
    await harness.setConfig("echo", { prefix: "re" })
    await harness.flush()
    harness.step("disable")
    await harness.disable("echo")
    await harness.flush()
    expect(
      harness.transcript({
        kinds: [
          "step",
          "fiber",
          "lifecycle",
          "status",
          "tools",
          "visible-tools",
          "storage",
          "settings",
        ],
      }),
    ).toEqual([
      { kind: "step", name: "enable" },
      { kind: "lifecycle", plugin: "echo", lifecycle: "starting" },
      {
        kind: "fiber",
        plugin: "echo",
        fiber: 1,
        from: "pending",
        to: "loading",
      },
      {
        kind: "status",
        plugin: "echo",
        status: { state: "ready", code: "ready", summary: "Prefix: echo" },
      },
      { kind: "tools", plugin: "echo", registered: ["echo"], withdrawn: [] },
      {
        kind: "fiber",
        plugin: "echo",
        fiber: 1,
        from: "loading",
        to: "active",
      },
      { kind: "lifecycle", plugin: "echo", lifecycle: "active" },
      {
        kind: "settings",
        plugin: "echo",
        changes: [
          { path: "$schema", after: "maximal-plugin-settings/1" },
          { path: "plugin", after: "echo" },
          { path: "version", after: 1 },
          { path: "tools.catalog.updatedAt", after: "<time>" },
          { path: "tools.catalog.tools", after: ["echo"] },
        ],
      },
      { kind: "step", name: "call" },
      { kind: "storage", plugin: "echo", op: "write", name: "last.txt" },
      { kind: "step", name: "block" },
      {
        kind: "settings",
        plugin: "echo",
        changes: [{ path: "tools.permissions.echo", after: "block" }],
      },
      { kind: "visible-tools", plugin: "echo", shown: [], hidden: ["echo"] },
      { kind: "step", name: "reload" },
      {
        kind: "settings",
        plugin: "echo",
        changes: [{ path: "config.prefix", after: "re" }],
      },
      {
        kind: "fiber",
        plugin: "echo",
        fiber: 1,
        from: "active",
        to: "unloading",
      },
      { kind: "tools", plugin: "echo", registered: [], withdrawn: ["echo"] },
      {
        kind: "fiber",
        plugin: "echo",
        fiber: 1,
        from: "unloading",
        to: "disposed",
      },
      { kind: "status", plugin: "echo", status: null },
      { kind: "lifecycle", plugin: "echo", lifecycle: "starting" },
      {
        kind: "fiber",
        plugin: "echo",
        fiber: 2,
        from: "pending",
        to: "loading",
      },
      {
        kind: "status",
        plugin: "echo",
        status: { state: "ready", code: "ready", summary: "Prefix: re" },
      },
      { kind: "tools", plugin: "echo", registered: ["echo"], withdrawn: [] },
      {
        kind: "fiber",
        plugin: "echo",
        fiber: 2,
        from: "loading",
        to: "active",
      },
      { kind: "lifecycle", plugin: "echo", lifecycle: "active" },
      {
        kind: "settings",
        plugin: "echo",
        changes: [
          {
            path: "tools.catalog.updatedAt",
            before: "<time>",
            after: "<time>",
          },
        ],
      },
      { kind: "step", name: "disable" },
      {
        kind: "fiber",
        plugin: "echo",
        fiber: 2,
        from: "active",
        to: "unloading",
      },
      { kind: "tools", plugin: "echo", registered: [], withdrawn: ["echo"] },
      {
        kind: "fiber",
        plugin: "echo",
        fiber: 2,
        from: "unloading",
        to: "disposed",
      },
      { kind: "status", plugin: "echo", status: null },
      { kind: "lifecycle", plugin: "echo", lifecycle: "disabled" },
    ])
    expect(harness.files("echo")).toEqual(["last.txt", "settings.json"])
  })

  test("masks secrets in the transcript and reports where they appeared", async () => {
    const leaky = define("leaky", z.object({}), (ctx) => {
      ctx.host.logger.info("token is s3cr3t-value")
    })
    harness = createLifecycleHarness({
      plugins: [leaky],
      secrets: ["s3cr3t-value"],
    })
    await harness.enable("leaky")
    expect(harness.transcript({ kinds: ["log"] })).toEqual([
      {
        kind: "log",
        level: "info",
        message: "[plugin:leaky] token is <secret>",
      },
    ])
    expect(harness.secretsSeen().map((seen) => seen.secret)).toEqual([
      "s3cr3t-value",
    ])
  })

  test("notices a plugin writing settings.json behind the host's back", async () => {
    const sneaky = define("sneaky", z.object({}), (ctx) => {
      mkdirSync(ctx.storage.dir, { recursive: true })
      writeFileSync(path.join(ctx.storage.dir, "settings.json"), "{}")
    })
    harness = createLifecycleHarness({ plugins: [sneaky] })
    await harness.enable("sneaky")
    expect(harness.settingsTamperedWith("sneaky")).toBe(true)
  })
})

describe("trackHandles", () => {
  test("reports intervals and long timeouts a plugin leaves behind", async () => {
    const leaking = define("leaking", z.object({}), () => {
      setInterval(() => {}, 60_000).unref()
      setTimeout(() => {}, 60_000).unref()
      setTimeout(() => {}, 1)
    })
    const tracker = trackHandles()
    try {
      harness = createLifecycleHarness({ plugins: [leaking] })
      await harness.enable("leaking")
      await harness.disable("leaking")
      const live = tracker.live()
      expect(live.map((handle) => `${handle.kind} ${handle.detail}`)).toEqual([
        "interval 60000 ms",
        "timeout 60000 ms",
      ])
      expect(live[0].stack.join("\n")).toContain("testing.test.ts")
    } finally {
      tracker.stop()
    }
  })

  test("a cleared interval and a stopped server are not leaks", async () => {
    const tracker = trackHandles()
    try {
      const interval = setInterval(() => {}, 60_000)
      clearInterval(interval)
      const server = Bun.serve({ port: 0, fetch: () => new Response("ok") })
      expect(tracker.live().map((handle) => handle.kind)).toEqual(["server"])
      await server.stop(true)
      expect(tracker.live()).toEqual([])
    } finally {
      tracker.stop()
    }
  })
})
