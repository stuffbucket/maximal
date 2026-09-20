import consola from "consola"

import type { AppEntry } from "~/lib/config/settings-types"

import type { AppCli, AppCliOp, ClientApp } from "./index"

/** CLI behavior for a coming-soon app, registered via the existing
 *  `ClientApp.cli` hook so the generic `maximal app` framework never has to
 *  branch on `kind`. `status` falls through to the shared status printer (which
 *  renders the coming-soon `getDetails` correctly); `enable`/`disable` are fully
 *  handled here with a notice. */
function comingSoonCli(name: string): AppCli {
  return {
    handle(op: AppCliOp): boolean {
      if (op === "status") return false // → generic showStatus → getDetails
      consola.info(`${name} is coming soon; not available yet.`)
      return true
    },
  }
}

/** A fully-formed placeholder `ClientApp` for an integration that isn't live
 *  yet. No `apiKeyLabel` (no key surface — `maximal api <client>` reports "no
 *  key" rather than minting the default). Collapses what was a ~40-line per-app
 *  literal down to one call, and keeps the coming-soon defaults in one place
 *  instead of a special case in the CLI framework. */
export function defineComingSoonApp(spec: {
  id: AppEntry["id"]
  name: string
}): ClientApp {
  const { id, name } = spec
  return {
    id,
    name,
    kind: "coming-soon",
    detect: () => Promise.resolve(false),
    getDetails: () =>
      Promise.resolve({
        id,
        name,
        kind: "coming-soon",
        enabled: false,
        status: "coming-soon",
        installs: [],
        install: null,
        conflict: null,
      }),
    enable: () => Promise.resolve({ success: false }),
    disable: () => Promise.resolve({ success: true }),
    uninstall: () => Promise.resolve({ reverted: [] }),
    isEnabled: () => false,
    cli: comingSoonCli(name),
  }
}
