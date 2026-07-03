/**
 * Tests for the registry-driven `maximal app` / `maximal api` command
 * framework (src/apps/cli.ts) and the Claude Desktop `AppCli` hook.
 *
 * These exercise command WIRING (metadata, generated subcommands, arg
 * merging) and the pure branches of the Claude Desktop hook — not the
 * enable/disable/resolveApiKey behaviour itself, which is covered by
 * `apps-route`, `claude-code-settings`, and `api-key-helper` tests. Keeping
 * this file mock-free avoids Bun's forward-persisting `mock.module` hazard
 * (see apps-route.test.ts's note).
 */

import type { ArgsDef, CommandDef } from "citty"

import { describe, expect, test } from "bun:test"

import { claudeDesktopCli } from "~/apps/claude-desktop/cli"
import { apiCommand, appCommand } from "~/apps/cli"
import { defineComingSoonApp } from "~/apps/coming-soon"
import { getAllApps, getApp } from "~/apps/registry"
import { apiKeyHelperCommand } from "~/lib/api-key-helper"
import { HELPER_SUBCOMMAND } from "~/lib/api-key-helper-tokens"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors citty's CommandDef<any> subcommand map
type AnyCommand = CommandDef<any>

async function resolveMaybe<T>(
  value: T | (() => T) | (() => Promise<T>) | undefined,
): Promise<T | undefined> {
  if (typeof value === "function") {
    const r = (value as () => T | Promise<T>)()
    return await Promise.resolve(r)
  }
  return await Promise.resolve(value)
}

async function subCommands(cmd: AnyCommand): Promise<Record<string, unknown>> {
  const subs = await resolveMaybe(cmd.subCommands)
  return subs ?? {}
}

async function argsOf(cmd: unknown): Promise<ArgsDef> {
  const typed = cmd as CommandDef
  const args = await resolveMaybe(typed.args)
  return args ?? {}
}

const APP_IDS = getAllApps().map((a) => a.id)

describe("maximal app command", () => {
  test("exposes the documented metadata", async () => {
    const meta = await resolveMaybe(appCommand.meta)
    expect(meta?.name).toBe("app")
    expect(meta?.description).toContain("client")
  })

  test("generates one subcommand per registered app, plus list", async () => {
    const subs = await subCommands(appCommand)
    expect(Object.keys(subs).sort()).toEqual([...APP_IDS, "list"].sort())
  })

  test("each app subcommand carries the shared --enable/--disable flags", async () => {
    const subs = await subCommands(appCommand)
    for (const id of APP_IDS) {
      const args = await argsOf(subs[id])
      expect(args.enable.type).toBe("boolean")
      expect(args.disable.type).toBe("boolean")
    }
  })

  test("merges an app's extra flags on top of the shared ones", async () => {
    const subs = await subCommands(appCommand)
    const args = await argsOf(subs["claude-desktop"])
    // shared + claude-desktop extras coexist
    expect(args.enable.type).toBe("boolean")
    expect(args.disable.type).toBe("boolean")
    expect(args.force.type).toBe("boolean")
    expect(args.managed.type).toBe("boolean")
  })
})

describe("maximal api command", () => {
  test("exposes the documented metadata", async () => {
    const meta = await resolveMaybe(apiCommand.meta)
    expect(meta?.name).toBe("api")
    expect(meta?.description).toContain("--apiKeyHelper")
  })

  test("generates one subcommand per registered app, plus list", async () => {
    const subs = await subCommands(apiCommand)
    expect(Object.keys(subs).sort()).toEqual([...APP_IDS, "list"].sort())
  })

  test("no drift: the verb in the on-disk helper command equals the command name", async () => {
    // The token written into client configs (`<bin> api <label>`) MUST match the
    // command citty dispatches on, or an existing on-disk config resolves to
    // nothing. Both derive from HELPER_SUBCOMMAND; this locks that they agree.
    const written = apiKeyHelperCommand("claude-code", "/bin/maximal")
    expect(written).toBe(`"/bin/maximal" ${HELPER_SUBCOMMAND} claude-code`)
    const meta = await resolveMaybe(apiCommand.meta)
    expect(meta?.name).toBe(HELPER_SUBCOMMAND)
  })
})

describe("claudeDesktopCli hook", () => {
  test("declares the --force and --managed extra flags", () => {
    expect(claudeDesktopCli.extraArgs?.force.type).toBe("boolean")
    expect(claudeDesktopCli.extraArgs?.managed.type).toBe("boolean")
  })

  test("does not intercept status or disable (falls through to generic)", async () => {
    // Pure branches: these return false WITHOUT touching the filesystem, so
    // the generic framework runs ClientApp.disable()/getDetails() instead.
    expect(await claudeDesktopCli.handle?.("status", {})).toBe(false)
    expect(await claudeDesktopCli.handle?.("disable", {})).toBe(false)
  })
})

describe("defineComingSoonApp", () => {
  const app = defineComingSoonApp({ id: "copilot-cli", name: "Copilot CLI" })

  test("has no apiKeyLabel (no key surface)", () => {
    expect(app.apiKeyLabel).toBeUndefined()
  })

  test("cli.handle falls through for status but handles mutations", async () => {
    // status → false so the generic path renders the coming-soon getDetails;
    // enable/disable → true (fully handled, prints the coming-soon notice).
    expect(await app.cli?.handle?.("status", {})).toBe(false)
    expect(await app.cli?.handle?.("enable", {})).toBe(true)
    expect(await app.cli?.handle?.("disable", {})).toBe(true)
  })

  test("getDetails reports the coming-soon placeholder payload", async () => {
    expect(await app.getDetails()).toEqual({
      id: "copilot-cli",
      name: "Copilot CLI",
      kind: "coming-soon",
      enabled: false,
      status: "coming-soon",
      installs: [],
      install: null,
      conflict: null,
    })
  })
})

describe("apiKeyLabel — single source for api <client>", () => {
  test("claude-code's label matches the on-disk --apiKeyHelper token", () => {
    // The label feeding `maximal api claude-code` MUST equal the label written
    // into ~/.claude/settings.json, else the two resolve different keys. It's
    // single-sourced from claude-code's HELPER_LABEL.
    expect(getApp("claude-code")?.apiKeyLabel).toBe("claude-code")
  })

  test("claude-desktop declares its label explicitly", () => {
    expect(getApp("claude-desktop")?.apiKeyLabel).toBe("claude-desktop")
  })

  test("copilot-cli (coming-soon) has no key surface", () => {
    expect(getApp("copilot-cli")?.apiKeyLabel).toBeUndefined()
  })
})
