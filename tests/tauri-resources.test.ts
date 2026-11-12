import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

/**
 * Pins the "the packaged UI is embedded in the sidecar binary, not staged
 * as a Tauri resource" architecture (src/routes/ui/route.ts + the embed
 * generator). The old approach shipped `shell/dist` as a `bundle.resources`
 * entry and pointed the sidecar at it via MAXIMAL_SETTINGS_DIST; the CLI /
 * Homebrew bottle never carried that directory, so /settings 503'd on those
 * channels (issue #132). Embedding the UI in the binary fixes that, so the
 * resource staging must NOT come back.
 */

const REPO_ROOT = resolve(import.meta.dir, "..")
const TAURI_ROOT = resolve(REPO_ROOT, "shell", "src-tauri")
const TAURI_CONF = resolve(TAURI_ROOT, "tauri.conf.json")

interface TauriConf {
  bundle?: {
    externalBin?: Array<string>
    resources?: Array<string> | Record<string, string>
    windows?: { nsis?: { installerHooks?: string } }
  }
}

function loadConf(): TauriConf {
  return JSON.parse(readFileSync(TAURI_CONF, "utf8")) as TauriConf
}

function resourcePatterns(conf: TauriConf): Array<string> {
  const r = conf.bundle?.resources
  if (!r) return []
  return Array.isArray(r) ? r : Object.keys(r)
}

describe("Tauri packaging contracts", () => {
  test("tauri.conf.json parses", () => {
    expect(() => loadConf()).not.toThrow()
  })

  test("does not stage shell/dist as a Tauri resource (it's embedded instead)", () => {
    const patterns = resourcePatterns(loadConf())
    const stagesDist = patterns.some((p) => /dist/i.test(p))
    expect(
      stagesDist,
      `tauri.conf.json bundle.resources stages a dist directory (${JSON.stringify(patterns)}). `
        + "The UI is now embedded in the sidecar binary (src/routes/ui/route.ts) — "
        + "staging it again resurrects the #132 split where CLI/Homebrew lacked it.",
    ).toBe(false)
  })

  test("packages the proxy sidecar and sealed plugin generation", () => {
    expect(loadConf().bundle?.externalBin).toEqual(["binaries/maximal"])
    expect(resourcePatterns(loadConf())).toContain("plugin-builtins")
  })

  test("contains Windows sidecars before their suspended process starts", () => {
    const cargo = readFileSync(resolve(TAURI_ROOT, "Cargo.toml"), "utf8")
    const patchPath = "patches/tauri-plugin-shell-2.6.0"
    expect(cargo).toContain('tauri-plugin-shell = "=2.6.0"')
    expect(cargo).toContain(`tauri-plugin-shell = { path = "${patchPath}" }`)

    const jobObject = readFileSync(
      resolve(TAURI_ROOT, patchPath, "src", "process", "job_object.rs"),
      "utf8",
    )
    const configure = jobObject.indexOf("SetInformationJobObject(")
    const assign = jobObject.indexOf("AssignProcessToJobObject(")
    const resume = jobObject.indexOf("resume_threads(child.id())")
    expect(jobObject).toContain("JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE")
    expect(configure).toBeGreaterThan(-1)
    expect(assign).toBeGreaterThan(configure)
    expect(resume).toBeGreaterThan(assign)
  })

  test("the NSIS installer and uninstaller stop every Maximal process", () => {
    // These hooks run before Tauri's CheckIfAppIsRunning. The shell must be
    // stopped without /T so an updater-launched installer is not killed as a
    // descendant; the sidecar tree is then stopped explicitly, plus a broker an older
    // install may have left running (current builds don't ship one).
    const hooksPath = loadConf().bundle?.windows?.nsis?.installerHooks
    expect(hooksPath).toBe("./windows/hooks.nsh")
    const hooksFile = resolve(dirname(TAURI_CONF), hooksPath ?? "")
    expect(existsSync(hooksFile)).toBe(true)
    const hooks = readFileSync(hooksFile, "utf8")
    for (const hook of ["NSIS_HOOK_PREINSTALL", "NSIS_HOOK_PREUNINSTALL"]) {
      const body = new RegExp(`!macro ${hook}\\n([\\s\\S]*?)!macroend`).exec(
        hooks,
      )?.[1]
      expect(body, hook).toContain(
        String.raw`"$SYSDIR\taskkill.exe" /F /IM maximal-shell.exe`,
      )
      expect(body, hook).not.toContain(
        String.raw`"$SYSDIR\taskkill.exe" /F /IM maximal-shell.exe /T`,
      )
      expect(body, hook).toContain(
        String.raw`"$SYSDIR\taskkill.exe" /F /IM maximal.exe /T`,
      )
      expect(body, hook).toContain(
        String.raw`"$SYSDIR\taskkill.exe" /F /IM maximal-mcp-broker.exe /T`,
      )
    }
  })

  test("the embed mechanism is present (generator + route)", () => {
    expect(existsSync(resolve(REPO_ROOT, "scripts", "gen-ui-embed.ts"))).toBe(
      true,
    )
    const route = readFileSync(
      resolve(REPO_ROOT, "src", "routes", "ui", "route.ts"),
      "utf8",
    )
    expect(route).toContain("UI_FILES")
  })
})
