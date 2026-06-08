#!/usr/bin/env node
/**
 * `maximal setup` — first-run wizard.
 *
 * Client-neutral by design: takes a freshly-installed binary from
 * "just unpacked" to "the proxy is reachable and authenticated."
 * Three steps:
 *
 *   1. GitHub auth (device-code flow if no token)
 *   2. Diagnostic — render `maximal debug` so the user sees the
 *      effective config
 *   3. Smoke test — one /v1/messages request to confirm reachability
 *
 * Pairing the proxy with a specific client (Claude Desktop, Claude
 * Code, opencode, the AI SDK, custom apps) is a deliberate follow-up
 * step. For Claude Desktop specifically, run
 * `maximal configure-claude-desktop` after this.
 *
 * Runs in two modes: interactive (default) and unattended (used by
 * post-install scripts in B2/B3a). Unattended skips prompts and the
 * smoke test.
 *
 * Spec: docs/spec/archive/internal-distribution-stream-b.md §B5.
 */

import { defineCommand } from "citty"
import consola from "consola"

import { runDebug } from "./debug"
import { ensurePaths } from "./lib/paths"
import { state } from "./lib/state"
import { setupGitHubToken } from "./lib/token"

interface RunSetupOptions {
  unattended: boolean
  skipAuth: boolean
  skipSmoke: boolean
  noBrowser: boolean
  port: number
}

export async function runSetup(opts: RunSetupOptions): Promise<void> {
  consola.box("maximal setup")

  await ensurePaths()

  // 1. GitHub auth ---------------------------------------------------
  if (!opts.skipAuth) {
    consola.info("Step 1/3: GitHub authentication")
    try {
      // setupGitHubToken is idempotent — won't re-prompt if a valid
      // token already exists on disk. `noBrowser` skips the auto-open
      // step (still prints the URL+code).
      await setupGitHubToken({ force: false, noBrowser: opts.noBrowser })
      consola.success("GitHub authenticated")
    } catch (err) {
      consola.error("GitHub auth failed", err)
      // In unattended mode, soldier on — installer may run setup
      // again on first user login when a real shell is present.
      if (!opts.unattended) throw err
    }
  } else {
    consola.info("Step 1/3: GitHub authentication (skipped)")
  }

  // 2. Diagnostic ----------------------------------------------------
  consola.info("Step 2/3: Effective config")
  await runDebug({ json: false })

  // 3. Smoke test ----------------------------------------------------
  let smokePassed: boolean | null = null
  if (!opts.skipSmoke && !opts.unattended) {
    consola.info("Step 3/3: Smoke test")
    smokePassed = await smokeTest(opts.port)
  } else {
    consola.info("Step 3/3: Smoke test (skipped)")
  }

  // Be honest about the outcome. A failed smoke test isn't fatal (the proxy
  // simply wasn't running yet), but saying "Setup complete" over a failed
  // check would dead-end the user into thinking everything's wired when the
  // proxy never answered. Tell them the one thing to do next.
  if (smokePassed === false) {
    consola.box("Setup finished — but the smoke test didn't pass.")
    consola.info(
      "Auth and config are in place. The proxy just wasn't reachable yet.\n"
        + "  1. Start it:   maximal start\n"
        + "  2. Re-check:   maximal setup\n"
        + "Pair Claude Desktop once it's up: maximal configure-claude-desktop",
    )
    return
  }

  consola.box("Setup complete.")
  consola.info(
    "To pair Claude Desktop with this proxy, run:\n"
      + "  maximal configure-claude-desktop",
  )
}

// ────────────────────────────────────────────────────────────────────
// Step 3: Smoke test.
// ────────────────────────────────────────────────────────────────────

async function smokeTest(port: number): Promise<boolean> {
  const url = `http://localhost:${port}/v1/messages`
  let response: Response
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "anything",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4.5",
        max_tokens: 32,
        messages: [{ role: "user", content: "hello" }],
      }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    consola.warn(
      `  Could not reach the proxy at ${url}. Start it with \`maximal start\` in another terminal, then re-run setup.`,
      err,
    )
    return false
  }
  if (!response.ok) {
    consola.warn(`  Proxy responded ${response.status} ${response.statusText}`)
    return false
  }
  consola.success(`  Proxy responded 200 from ${url}`)
  return true
}

// ────────────────────────────────────────────────────────────────────
// citty wrapper.
// ────────────────────────────────────────────────────────────────────

export const setup = defineCommand({
  meta: {
    name: "setup",
    description:
      "First-run wizard: GitHub auth + smoke test. Client wiring (Claude Desktop, etc.) is opt-in via separate subcommands.",
  },
  args: {
    unattended: {
      type: "boolean",
      default: false,
      description: "Run without prompts. No smoke test.",
    },
    "skip-auth": {
      type: "boolean",
      default: false,
      description:
        "Skip the GitHub device-code flow. Useful for post-install scripts that run as a different user.",
    },
    "skip-smoke": {
      type: "boolean",
      default: false,
      description: "Skip the /v1/messages smoke-test step.",
    },
    "no-browser": {
      type: "boolean",
      default: false,
      description:
        "Don't auto-open the device-code verification URL. Print it for manual paste (useful over SSH).",
    },
    port: {
      alias: "p",
      type: "string",
      default: "4141",
      description: "Port the proxy listens on (smoke test only).",
    },
  },
  run({ args }) {
    state.showToken = false
    return runSetup({
      unattended: args.unattended,
      skipAuth: args["skip-auth"],
      skipSmoke: args["skip-smoke"],
      noBrowser: args["no-browser"],
      port: Number.parseInt(args.port, 10),
    })
  },
})
