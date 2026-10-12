import { expect, test } from "bun:test"

import {
  COPILOT_REVIEW_MODEL,
  readCatalogRuntimes,
  validateReviewCatalog,
} from "~/apps/codex/catalog-runtime"

// Opt-in offline integration with the actual installed binary. It never loads
// the developer's Codex home or makes a model request.
const executable = process.env.MAXIMAL_TEST_CODEX_EXECUTABLE
test.skipIf(!executable)(
  "installed native Codex loads reviewer overrides for every bundled task model",
  async () => {
    if (!executable) return
    const runtimes = await readCatalogRuntimes([
      { path: executable, version: null, source: "path" },
    ])
    const catalog = structuredClone(runtimes[0].catalog)
    for (const model of catalog.models)
      model.auto_review_model_override = COPILOT_REVIEW_MODEL
    await validateReviewCatalog(
      runtimes,
      catalog,
      catalog.models.map((model) => model.slug),
    )
    expect(catalog.models.some((model) => model.slug === "gpt-6-luna")).toBe(
      true,
    )
  },
  60000,
)
