/**
 * Pin Codex's bundled model catalog into the repo.
 *
 * Codex asks `/models?client_version=…` for its own catalog shape, where
 * every entry carries Codex's system prompt. Like LiteLLM and opencodex, we
 * answer from a pinned snapshot of Codex's own `models.json` (models Codex
 * already knows keep their tuned prompts) plus its generic `prompt.md` (what
 * Codex itself falls back to for unknown models). Never fetched at runtime.
 *
 *   bun scripts/pin-codex-catalog.ts rust-v0.146.1
 *
 * Re-pin when a Codex release changes the catalog shape or prompts. Source is
 * openai/codex, Apache-2.0.
 */

import fs from "node:fs"
import path from "node:path"

const REPO = "openai/codex"
const OUT = path.join(
  import.meta.dir,
  "..",
  "src",
  "apps",
  "codex",
  "data",
  "codex-catalog.json",
)

async function fetchText(tag: string, file: string): Promise<string> {
  const url = `https://raw.githubusercontent.com/${REPO}/${tag}/${file}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return res.text()
}

const tag = process.argv[2]
if (!tag) {
  console.error("usage: bun scripts/pin-codex-catalog.ts <openai/codex tag>")
  process.exit(1)
}

const catalog = JSON.parse(
  await fetchText(tag, "codex-rs/models-manager/models.json"),
) as { models: Array<unknown> }
const fallbackInstructions = await fetchText(
  tag,
  "codex-rs/models-manager/prompt.md",
)

const pinned = {
  source: {
    repo: REPO,
    tag,
    files: [
      "codex-rs/models-manager/models.json",
      "codex-rs/models-manager/prompt.md",
    ],
    license: "Apache-2.0",
  },
  fallbackInstructions,
  models: catalog.models,
}
fs.writeFileSync(OUT, `${JSON.stringify(pinned, null, 2)}\n`)
console.log(`pinned ${catalog.models.length} models from ${REPO}@${tag} → ${OUT}`)
