import { type Dirent, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"

/** Workspace packages compiled into the sidecar besides `src/`. */
function isSidecarPackage(name: string): boolean {
  return (
    name.startsWith("plugin-")
    || name.startsWith("figjam-")
    || name === "connector-kit"
  )
}

/**
 * What a change to the sidecar's workspace packages must rebuild it for: the
 * `src/`, `scripts/` and `package.json` of every `packages/plugin-*`,
 * `packages/figjam-*` and `connector-kit` workspace.
 *
 * `plugin-figjam` imports the bridge and the Figma plugin build, and the
 * plugin build embeds `src/legacy/code.js` and `ui.html` as text, so those
 * packages (and `figjam-plugin/scripts/build.ts`) are part of the binary even
 * though nothing under `src/` of the root imports them directly.
 */
export function packageSources(packagesDir: string): Array<string> {
  let entries: Array<Dirent>
  try {
    entries = readdirSync(packagesDir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory() && isSidecarPackage(entry.name))
    .flatMap((entry) => {
      const base = join(packagesDir, entry.name)
      // A package without a `scripts/` folder must not read as "changed".
      return [
        join(base, "src"),
        join(base, "scripts"),
        join(base, "package.json"),
      ].filter((candidate) => existsSync(candidate))
    })
}
