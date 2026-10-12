import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { z } from "zod"

import type { AppInstall } from "~/lib/config/settings-types"

import {
  COPILOT_REVIEW_MODEL,
  executablePaths,
  parseCatalog,
  readCatalogRuntimes,
  runtimeFingerprint,
  validateReviewCatalog,
  type CodexCatalog,
} from "./catalog-runtime"
import { codexConfigPath, configuredModel } from "./config"
import { findSetting, parseConfig, replaceSetting } from "./toml"

const START = "# >>> maximal review catalog >>>"
const END = "# <<< maximal review catalog <<<"
const META = "# maximal-review-catalog: "
const SETTING = ["model_catalog_json"]
const hash = (text: string): string =>
  createHash("sha256").update(text).digest("hex")

const CatalogState = z.object({
  version: z.literal(1),
  before: z.string().nullable(),
  after: z.string(),
  file: z.string(),
  digest: z.string(),
  source: z.object({ file: z.string(), digest: z.string() }).nullable(),
  runtimes: z.array(
    z.object({
      executable: z.string(),
      fingerprint: z.string(),
      version: z.string(),
    }),
  ),
  taskModels: z.array(z.string()),
})
type CatalogState = z.infer<typeof CatalogState>

function stateBlock(state: CatalogState): string {
  return `\n${START}\n${META}${Buffer.from(JSON.stringify(state)).toString("base64")}\n${END}\n`
}

function ownedCatalog(
  text: string,
): { state: CatalogState; block: string } | null {
  const start = text.indexOf(`\n${START}\n`)
  if (
    start === -1
    && !text.includes(START)
    && !text.includes(END)
    && !text.includes(META)
  )
    return null
  try {
    const end = text.indexOf(`${END}\n`, start)
    const block = text.slice(start, end + END.length + 1)
    const line = block.split("\n")[2]
    if (start < 0 || end < 0 || !line.startsWith(META)) throw new Error()
    const state = CatalogState.parse(
      JSON.parse(
        Buffer.from(line.slice(META.length), "base64").toString("utf8"),
      ),
    )
    if (
      stateBlock(state) !== block
      || text.includes(START, start + START.length + 1)
    )
      throw new Error()
    if (parseConfig(state.after).model_catalog_json !== state.file)
      throw new Error()
    return { state, block }
  } catch {
    throw new Error(
      "Maximal's Codex catalog metadata was edited. Restore its marked block before changing the connection.",
    )
  }
}

function readSource(text: string, owned: ReturnType<typeof ownedCatalog>) {
  const value =
    owned ? owned.state.source?.file : parseConfig(text).model_catalog_json
  if (value === undefined || value === null) return null
  if (typeof value !== "string" || !value)
    throw new Error("Codex model_catalog_json must name a local catalog file.")
  const file = path.resolve(path.dirname(codexConfigPath()), value)
  const content = fs.readFileSync(file, "utf8")
  return { file, digest: hash(content), catalog: parseCatalog(content) }
}

/** Custom metadata wins, while new bundled entries and fields remain available. */
function mergeCatalog(
  bundled: CodexCatalog,
  custom?: CodexCatalog,
): CodexCatalog {
  if (!custom) return structuredClone(bundled)
  const ids = new Set(custom.models.map((model) => model.slug))
  return {
    ...bundled,
    ...custom,
    models: [
      ...custom.models.map((model) => ({
        ...bundled.models.find((entry) => entry.slug === model.slug),
        ...model,
      })),
      ...bundled.models.filter((model) => !ids.has(model.slug)),
    ],
  }
}

function assertUnedited(
  text: string,
  owned: ReturnType<typeof ownedCatalog>,
): void {
  if (!owned) return
  if (findSetting(text, SETTING)?.text !== owned.state.after) {
    throw new Error(
      "Your Codex catalog selection changed. Disconnect Maximal settings before configuring again; your selection will be preserved.",
    )
  }
  if (
    fs.existsSync(owned.state.file)
    && hash(fs.readFileSync(owned.state.file, "utf8")) !== owned.state.digest
  ) {
    throw new Error(
      "Your Maximal Codex catalog was edited. Disconnect before configuring again to preserve those edits.",
    )
  }
}

export interface PreparedReviewCatalog {
  config: string
  file: string
  content: string
  taskModels: Array<string>
  checkUnchanged: () => void
}

export async function prepareReviewCatalog(
  text: string,
  options: {
    installs: Array<AppInstall>
    availableModels: Array<string>
    selectedModel: string
  },
  dependencies = { readCatalogRuntimes, validateReviewCatalog },
): Promise<PreparedReviewCatalog> {
  const { installs, availableModels, selectedModel } = options
  const owned = ownedCatalog(text)
  assertUnedited(text, owned)
  const source = readSource(text, owned)
  const runtimes = await dependencies.readCatalogRuntimes(installs)
  const catalog = mergeCatalog(runtimes[0].catalog, source?.catalog)
  const taskModels = catalog.models
    .filter((model) => availableModels.includes(model.slug))
    .map((model) => model.slug)
    .sort()
  if (!taskModels.includes(COPILOT_REVIEW_MODEL)) {
    throw new Error(
      "The Astra automatic reviewer is unavailable through Copilot. Check your Maximal account and model access, then try again. No settings were changed.",
    )
  }
  if (!taskModels.includes(selectedModel)) {
    throw new Error(
      "Your task model has no supported Codex catalog entry. Choose a supported model in Codex, then configure again.",
    )
  }
  for (const model of catalog.models) {
    if (taskModels.includes(model.slug))
      model.auto_review_model_override = COPILOT_REVIEW_MODEL
  }
  await dependencies.validateReviewCatalog(runtimes, catalog, taskModels)
  const content = JSON.stringify(catalog, null, 2) + "\n"
  const digest = hash(content)
  const file = path.join(
    path.dirname(codexConfigPath()),
    "maximal-catalogs",
    `${digest}.json`,
  )
  const before =
    owned ? owned.state.before : (findSetting(text, SETTING)?.text ?? null)
  const after = `model_catalog_json = ${JSON.stringify(file)}\n`
  const state: CatalogState = {
    version: 1,
    before,
    after,
    file,
    digest,
    source: source && { file: source.file, digest: source.digest },
    runtimes: runtimes.map(({ executable, fingerprint, version }) => ({
      executable,
      fingerprint,
      version,
    })),
    taskModels,
  }
  const base = owned ? text.replace(owned.block, "") : text
  const config =
    replaceSetting(base, SETTING, { replacement: after, value: file })
    + stateBlock(state)
  return {
    config,
    file,
    content,
    taskModels,
    checkUnchanged() {
      assertUnedited(text, owned)
      if (
        source
        && hash(fs.readFileSync(source.file, "utf8")) !== source.digest
      )
        throw new Error(
          "Your custom Codex catalog changed during configuration. Try again.",
        )
      for (const runtime of runtimes) {
        if (runtimeFingerprint(runtime.executable) !== runtime.fingerprint)
          throw new Error("Codex changed during configuration. Try again.")
      }
    },
  }
}

/** Publish an immutable private snapshot before committing its config pointer.
 * Old files are retained: other profiles or running clients can still use them. */
export function writeReviewCatalog(prepared: PreparedReviewCatalog): void {
  prepared.checkUnchanged()
  const directory = path.dirname(prepared.file)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (fs.lstatSync(directory).isSymbolicLink())
    throw new Error(
      "Maximal's Codex catalog directory is a symlink. No settings were changed.",
    )
  if (fs.existsSync(prepared.file)) {
    if (
      fs.lstatSync(prepared.file).isSymbolicLink()
      || fs.readFileSync(prepared.file, "utf8") !== prepared.content
    )
      throw new Error(
        "The saved Maximal catalog changed. No settings were changed.",
      )
    return
  }
  const temporary = path.join(directory, `${randomUUID()}.tmp`)
  const descriptor = fs.openSync(temporary, "wx", 0o600)
  try {
    try {
      fs.writeFileSync(descriptor, prepared.content)
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
    // Exclusive publication also rejects a file/symlink created concurrently.
    fs.linkSync(temporary, prepared.file)
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
  }
}

export function withoutReviewCatalog(text: string): string {
  const owned = ownedCatalog(text)
  if (!owned) return text
  let next = text.replace(owned.block, "")
  const intact =
    !fs.existsSync(owned.state.file)
    || hash(fs.readFileSync(owned.state.file, "utf8")) === owned.state.digest
  if (intact && findSetting(next, SETTING)?.text === owned.state.after) {
    const before = owned.state.before
    next = replaceSetting(next, SETTING, {
      replacement: before ?? "",
      value:
        before === null ? undefined : parseConfig(before).model_catalog_json,
    })
  }
  return next
}

export function reviewCatalogIsCurrent(
  text: string,
  installs: Array<AppInstall>,
  availableModels: Array<string>,
): boolean {
  try {
    const owned = ownedCatalog(text)
    if (!owned) return false
    assertUnedited(text, owned)
    if (!fs.existsSync(owned.state.file)) return false
    const source = readSource(text, owned)
    if ((source?.digest ?? null) !== (owned.state.source?.digest ?? null))
      return false
    const paths = executablePaths(installs)
    if (paths.length !== owned.state.runtimes.length) return false
    if (
      !owned.state.runtimes.every(
        (runtime) =>
          paths.includes(runtime.executable)
          && runtimeFingerprint(runtime.executable) === runtime.fingerprint,
      )
    )
      return false
    const catalog = parseCatalog(fs.readFileSync(owned.state.file, "utf8"))
    const supported = catalog.models.filter((model) =>
      availableModels.includes(model.slug),
    )
    return (
      availableModels.includes(COPILOT_REVIEW_MODEL)
      && supported.some((model) => model.slug === configuredModel(text))
      && supported.every(
        (model) => model.auto_review_model_override === COPILOT_REVIEW_MODEL,
      )
    )
  } catch {
    return false
  }
}
