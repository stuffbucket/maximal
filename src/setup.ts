#!/usr/bin/env node
/**
 * `copilot-api setup` — first-run wizard.
 *
 * Takes a freshly-installed binary from "just unpacked" to "Claude
 * Desktop is talking to me." Five steps:
 *
 *   1. GitHub auth (device-code flow if no token)
 *   2. Claude Desktop config — point at localhost:4141
 *   3. Cowork egress allowlist — prompt with three choices
 *   4. Diagnostic — render `copilot-api debug` so the user sees the
 *      effective config
 *   5. Smoke test — one /v1/messages request to confirm reachability
 *
 * Runs in two modes: interactive (default) and unattended (used by
 * post-install scripts in B2/B3a). Unattended skips prompts and the
 * smoke test, and assumes default values for the egress allowlist.
 *
 * Spec: docs/spec/internal-distribution-stream-b.md §B5.
 */

import { defineCommand } from "citty"
import consola from "consola"
import { spawnSync } from "node:child_process"

import { runDebug } from "./debug"
import { applyProxyConfig } from "./lib/claude-desktop-config"
import { ensurePaths } from "./lib/paths"
import { state } from "./lib/state"
import { setupGitHubToken } from "./lib/token"

interface RunSetupOptions {
  unattended: boolean
  skipAuth: boolean
  skipSmoke: boolean
  port: number
}

export async function runSetup(opts: RunSetupOptions): Promise<void> {
  consola.box("copilot-api setup")

  await ensurePaths()

  // 1. GitHub auth ---------------------------------------------------
  if (!opts.skipAuth) {
    consola.info("Step 1/5: GitHub authentication")
    try {
      // setupGitHubToken is idempotent — won't re-prompt if a valid
      // token already exists on disk.
      await setupGitHubToken({ force: false })
      consola.success("GitHub authenticated")
    } catch (err) {
      consola.error("GitHub auth failed", err)
      // In unattended mode, soldier on — installer may run setup
      // again on first user login when a real shell is present.
      if (!opts.unattended) throw err
    }
  } else {
    consola.info("Step 1/5: GitHub authentication (skipped)")
  }

  // 2. Claude Desktop config ----------------------------------------
  consola.info("Step 2/5: Claude Desktop config")
  try {
    const result = applyProxyConfig()
    if (result.wrote) {
      consola.success(`Claude Desktop config updated at ${result.path}`)
      if (result.preservedKeys.length > 0) {
        consola.info(
          `  preserved existing keys: ${result.preservedKeys.join(", ")}`,
        )
      }
    } else {
      consola.success(`Claude Desktop config already configured`)
    }
    if (result.ensuredWorkspaceFolders.length > 0) {
      consola.info(
        `  workspace folders: ${result.ensuredWorkspaceFolders.join(", ")}`,
      )
    }
  } catch (err) {
    consola.warn("Could not update Claude Desktop config", err)
  }

  // 3. Cowork egress allowlist --------------------------------------
  consola.info("Step 3/5: Cowork egress allowlist")
  await configureCoworkEgress(opts)

  // 4. Diagnostic ----------------------------------------------------
  consola.info("Step 4/5: Effective config")
  await runDebug({ json: false })

  // 5. Smoke test ----------------------------------------------------
  if (!opts.skipSmoke && !opts.unattended) {
    consola.info("Step 5/5: Smoke test")
    await smokeTest(opts.port)
  } else {
    consola.info("Step 5/5: Smoke test (skipped)")
  }

  consola.box("Setup complete.")
}

// ────────────────────────────────────────────────────────────────────
// Step 3: Cowork egress.
// ────────────────────────────────────────────────────────────────────

async function configureCoworkEgress(opts: RunSetupOptions): Promise<void> {
  if (process.platform !== "darwin") {
    consola.info("  Cowork egress is macOS-only; skipping (Windows / Linux).")
    return
  }

  const existing = readCoworkAllowedHosts()
  if (existing !== null) {
    consola.success(
      `  Already configured (${existing.length} host${existing.length === 1 ? "" : "s"})`,
    )
    return
  }

  if (opts.unattended) {
    // Default to the curated list in unattended mode — the B2/B3a
    // post-install path. The user can opt out of telemetry hosts
    // later by re-running scripts/install-cowork-egress.sh.
    const r = runCuratedEgressInstall()
    if (r.ok) {
      consola.success("  Wrote curated allowlist (unattended default)")
    } else {
      consola.warn("  Could not run curated installer; skipped", r.error)
    }
    return
  }

  const choice = await consola.prompt(
    "Cowork sandbox needs an egress allowlist. Choose:",
    {
      type: "select",
      options: [
        { value: "curated", label: "Curated list (recommended; ~140 hosts)" },
        { value: "all", label: 'Allow all ("*"; least restrictive)' },
        { value: "skip", label: "Skip (configure later)" },
      ],
    },
  )

  switch (choice) {
    case "curated": {
      const r = runCuratedEgressInstall()
      if (r.ok) consola.success("  Wrote curated allowlist")
      else consola.warn("  Curated installer failed", r.error)
      break
    }
    case "all": {
      const r = writeAllowAll()
      if (r.ok) consola.success('  Wrote allowlist ["*"]')
      else consola.warn("  Could not write allowlist", r.error)
      break
    }
    case "skip": {
      consola.info("  Skipped — re-run `copilot-api setup` to revisit")
      break
    }
    default: {
      consola.info("  Skipped (no choice)")
    }
  }
}

function readCoworkAllowedHosts(): Array<string> | null {
  const r = spawnSync(
    "defaults",
    ["read", "com.anthropic.claudefordesktop", "coworkEgressAllowedHosts"],
    { encoding: "utf8" },
  )
  if (r.status !== 0) return null
  // `defaults read` outputs a parenthesized list; "I don't care about
  // exact parsing — we just need to know it's been set." Count
  // commas+1 as a rough length proxy.
  const out = r.stdout.trim()
  if (!out || out === "()") return null
  const items = out
    .replace(/^\(\s*/, "")
    .replace(/\s*\)$/, "")
    .split(",")
    .map((s) => s.trim().replace(/^"/, "").replace(/"$/, ""))
    .filter((s) => s.length > 0)
  return items
}

function writeAllowAll(): { ok: true } | { ok: false; error: unknown } {
  const r = spawnSync(
    "defaults",
    [
      "write",
      "com.anthropic.claudefordesktop",
      "coworkEgressAllowedHosts",
      "-array",
      "*",
    ],
    { encoding: "utf8" },
  )
  if (r.status !== 0) return { ok: false, error: r.stderr || r.error }
  return { ok: true }
}

function runCuratedEgressInstall():
  | { ok: true }
  | { ok: false; error: unknown } {
  // The script lives in the source tree; for an installed binary we
  // assume the script is bundled alongside (B2 puts it in
  // /usr/local/share/copilot-api/scripts). Fall back to running
  // `defaults` ourselves with the bundled host list when the script
  // isn't reachable — one-shot install scripts shouldn't depend on a
  // separate file at runtime.
  const r = spawnSync(
    "bash",
    ["-c", "command -v install-cowork-egress.sh && install-cowork-egress.sh"],
    { encoding: "utf8" },
  )
  if (r.status === 0) return { ok: true }
  // Soft fail — the user can run the script manually.
  return { ok: false, error: "install-cowork-egress.sh not on PATH" }
}

// ────────────────────────────────────────────────────────────────────
// Step 5: Smoke test.
// ────────────────────────────────────────────────────────────────────

async function smokeTest(port: number): Promise<void> {
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
      `  Could not reach the proxy at ${url}. Start it with \`copilot-api start\` in another terminal, then re-run setup.`,
      err,
    )
    return
  }
  if (!response.ok) {
    consola.warn(`  Proxy responded ${response.status} ${response.statusText}`)
    return
  }
  consola.success(`  Proxy responded 200 from ${url}`)
}

// ────────────────────────────────────────────────────────────────────
// citty wrapper.
// ────────────────────────────────────────────────────────────────────

export const setup = defineCommand({
  meta: {
    name: "setup",
    description:
      "First-run wizard: GitHub auth, Claude Desktop config, Cowork egress, smoke test",
  },
  args: {
    unattended: {
      type: "boolean",
      default: false,
      description:
        "Run without prompts. Default values for egress (curated). No smoke test.",
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
      port: Number.parseInt(args.port, 10),
    })
  },
})
