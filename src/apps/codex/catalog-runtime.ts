import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { z } from "zod"

import type { AppInstall } from "~/lib/config/settings-types"

// Keep unknown metadata, including instructions and future policy fields.
const CatalogSchema = z.looseObject({
  models: z.array(z.looseObject({ slug: z.string().min(1) })).min(1),
})
export type CodexCatalog = z.infer<typeof CatalogSchema>
export const COPILOT_REVIEW_MODEL = "gpt-6-astra"

export function parseCatalog(text: string): CodexCatalog {
  try {
    const catalog = CatalogSchema.parse(JSON.parse(text))
    const ids = catalog.models.map((model) => model.slug)
    if (new Set(ids).size !== ids.length) throw new Error()
    return catalog
  } catch {
    throw new Error(
      "Could not read the Codex model catalog. No settings were changed.",
    )
  }
}

export function executablePaths(installs: Array<AppInstall>): Array<string> {
  return [
    ...new Set(
      installs.map((install) =>
        install.path.endsWith(".app") ?
          path.join(install.path, "Contents", "Resources", "codex")
        : install.path,
      ),
    ),
  ]
}

export function runtimeFingerprint(executable: string): string {
  const stat = fs.statSync(executable)
  return `${fs.realpathSync(executable)}:${stat.size}:${stat.mtimeMs}`
}

export interface CatalogRuntime {
  executable: string
  fingerprint: string
  version: string
  catalog: CodexCatalog
}

async function inTemporaryHome<T>(
  run: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "maximal-codex-catalog-"),
  )
  try {
    return await run(directory)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

function runCodex(
  executable: string,
  args: Array<string>,
  directory: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        cwd: directory,
        // Never load the user's configuration, login, or project for discovery.
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          CODEX_HOME: directory,
        },
        timeout: 15000,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error)
          reject(
            new Error(
              "Codex could not load its offline review catalog. Update Codex CLI and Desktop, then configure the connection again. No settings were changed.",
            ),
          )
        else resolve(stdout)
      },
    )
  })
}

export async function readCatalogRuntimes(
  installs: Array<AppInstall>,
): Promise<Array<CatalogRuntime>> {
  return inTemporaryHome(async (directory) => {
    const runtimes: Array<CatalogRuntime> = []
    for (const executable of executablePaths(installs)) {
      const fingerprint = runtimeFingerprint(executable)
      const versionText = await runCodex(executable, ["--version"], directory)
      const version = /codex-cli\s+(\d+\.\d+\.\d+)/u.exec(versionText)?.[1]
      if (!version)
        throw new Error(
          "Could not identify the installed Codex version. Update Codex and try again.",
        )
      const catalog = parseCatalog(
        await runCodex(executable, ["debug", "models", "--bundled"], directory),
      )
      runtimes.push({ executable, fingerprint, version, catalog })
    }
    if (runtimes.length === 0)
      throw new Error(
        "Install Codex CLI or Desktop before configuring the connection.",
      )
    // One startup catalog is shared by CLI and Desktop. Use the newest bundle,
    // then require every installed client to load the resulting override.
    return runtimes.sort((a, b) =>
      b.version.localeCompare(a.version, undefined, { numeric: true }),
    )
  })
}

export async function validateReviewCatalog(
  runtimes: Array<CatalogRuntime>,
  catalog: CodexCatalog,
  taskModels: Array<string>,
): Promise<void> {
  await inTemporaryHome(async (directory) => {
    const file = path.join(directory, "models.json")
    fs.writeFileSync(file, JSON.stringify(catalog), { mode: 0o600 })
    for (const runtime of runtimes) {
      // A custom provider prevents authentication/remote catalog refresh. A
      // closed loopback port also makes an unexpected refresh fail safely.
      const loaded = parseCatalog(
        await runCodex(
          runtime.executable,
          [
            "-c",
            `model_catalog_json=${JSON.stringify(file)}`,
            "-c",
            'model_provider="maximal-catalog-check"',
            "-c",
            'model_providers.maximal-catalog-check={name="Offline catalog check",base_url="http://127.0.0.1:9/v1",wire_api="responses"}',
            "debug",
            "models",
          ],
          directory,
        ),
      )
      if (
        taskModels.some(
          (id) =>
            loaded.models.find((model) => model.slug === id)
              ?.auto_review_model_override !== COPILOT_REVIEW_MODEL,
        )
      ) {
        throw new Error(
          `Codex ${runtime.version} does not support this automatic review catalog. Update Codex CLI and Desktop, then try again. No settings were changed.`,
        )
      }
      if (runtimeFingerprint(runtime.executable) !== runtime.fingerprint) {
        throw new Error("Codex changed during configuration. Try again.")
      }
    }
  })
}
