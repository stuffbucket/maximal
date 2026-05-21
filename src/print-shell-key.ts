/**
 * `maximal print-shell-key` — prints the per-launch shell API key of
 * the currently running Maximal sidecar.
 *
 * The `max` wrapper script invokes this to env-inject ANTHROPIC_API_KEY
 * / OPENAI_API_KEY when launching a downstream tool. See ADR-0003.
 *
 * Implementation: a loopback HTTP GET against the sidecar's
 * `/_internal/shell-key` endpoint. The endpoint exists only when the
 * Tauri menubar app is the sidecar's parent (it sets MAXIMAL_SHELL_KEY
 * at spawn time); a plain `maximal start` invocation has no shell key
 * and the endpoint 404s. Either way the user gets a clear message.
 */

import { defineCommand } from "citty"

const DEFAULT_PORT = 4141

export const printShellKey = defineCommand({
  meta: {
    name: "print-shell-key",
    description:
      "Print the running Maximal sidecar's per-launch shell API key (used by the `max` wrapper).",
  },
  args: {
    port: {
      type: "string",
      default: String(DEFAULT_PORT),
      description: "Port the proxy is listening on.",
    },
  },
  async run({ args }) {
    const port = Number.parseInt(args.port, 10) || DEFAULT_PORT
    const url = `http://127.0.0.1:${port}/_internal/shell-key`

    let response: Response
    try {
      response = await fetch(url)
    } catch {
      process.stderr.write(
        `maximal: not running on :${port}. Open Maximal (menubar) or start the proxy first.\n`,
      )
      process.exit(1)
    }

    if (response.status === 404) {
      process.stderr.write(
        "maximal: no per-launch shell key (proxy is running standalone, not under the Tauri shell).\n"
          + "        Configure an API key in Settings → API keys, then export MAXIMAL_API_KEY in your shell.\n",
      )
      process.exit(2)
    }

    if (!response.ok) {
      process.stderr.write(
        `maximal: /_internal/shell-key returned HTTP ${response.status}\n`,
      )
      process.exit(3)
    }

    const key = (await response.text()).trim()
    if (!key) {
      process.stderr.write("maximal: empty shell key returned.\n")
      process.exit(4)
    }

    // stdout: just the key, no trailing newline beyond what the
    // consumer expects. The `max` script does `$(maximal
    // print-shell-key)` which strips trailing newlines anyway.
    process.stdout.write(key)
    process.stdout.write("\n")
  },
})
