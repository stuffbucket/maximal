import { describe, expect, it, beforeEach, afterEach } from "bun:test"

import {
  findEndpointModel,
  findInModels,
  normalizeSdkModelId,
} from "../src/lib/models/models"
import { state } from "../src/lib/runtime-state/state"

// findInModels is a pure function (no state), so tests are immune to the
// mock.module contamination that messages-handler.test.ts applies to
// ~/lib/models/models. findEndpointModel is a one-line wrapper around findInModels;
// its state-reading path is exercised by route integration tests.

const makeModel = (id: string, version: string, family: string) => ({
  capabilities: {
    family,
    limits: {},
    object: "model_capabilities" as const,
    supports: {},
    tokenizer: "o200k_base",
    type: "chat" as const,
  },
  id,
  model_picker_enabled: true,
  name: id,
  object: "model" as const,
  preview: false,
  vendor: "Anthropic",
  version,
  supported_endpoints: ["/v1/messages"],
})

// Fixture that mirrors what the Copilot /models endpoint returns today:
// IDs are date-suffixed (e.g. claude-sonnet-4-6-20260301) and version
// holds the dotted canonical form (claude-sonnet-4.6).
const CURRENT_MODELS = [
  makeModel("claude-opus-4-6-20260301", "claude-opus-4.6", "claude-opus-4.6"),
  makeModel(
    "claude-sonnet-4-6-20260301",
    "claude-sonnet-4.6",
    "claude-sonnet-4.6",
  ),
  makeModel(
    "claude-haiku-4-5-20260301",
    "claude-haiku-4.5",
    "claude-haiku-4.5",
  ),
]

describe("findInModels", () => {
  describe("exact match", () => {
    it("returns the model when the SDK ID matches m.id exactly for a Claude model", () => {
      const result = findInModels("claude-sonnet-4-6-20260301", CURRENT_MODELS)
      expect(result?.id).toBe("claude-sonnet-4-6-20260301")
    })

    // Non-Claude IDs can't be normalised, so only exact match works.
    // This test kills the ArrowFunction / ConditionalExpression mutations
    // that disable the exact-match predicate: without it the function
    // returns undefined instead of the model.
    it("returns a non-Claude model via exact match only", () => {
      const gptModel = makeModel("gpt-5.4", "1", "gpt")
      const result = findInModels("gpt-5.4", [gptModel])
      expect(result?.id).toBe("gpt-5.4")
    })

    it("returns undefined when models list is empty", () => {
      expect(findInModels("claude-sonnet-4-6", [])).toBeUndefined()
    })
  })

  describe("version-field match (regression: date-suffix ID format)", () => {
    // Before the fix, findEndpointModel would construct "claude-sonnet-4.6"
    // and compare it only against m.id. With date-suffixed IDs, m.id is
    // "claude-sonnet-4-6-20260301" so the lookup silently returned undefined
    // and the original model string was forwarded to Copilot → 400.
    it("resolves a dash-separated ID against m.version", () => {
      const result = findInModels("claude-sonnet-4-6", CURRENT_MODELS)
      expect(result?.id).toBe("claude-sonnet-4-6-20260301")
    })

    it("resolves a dotted ID (claude-sonnet-4.6) against m.version", () => {
      const result = findInModels("claude-sonnet-4.6", CURRENT_MODELS)
      expect(result?.id).toBe("claude-sonnet-4-6-20260301")
    })

    it("resolves an Anthropic date-suffixed SDK ID (claude-sonnet-4-6-20250514)", () => {
      const result = findInModels("claude-sonnet-4-6-20250514", CURRENT_MODELS)
      expect(result?.id).toBe("claude-sonnet-4-6-20260301")
    })

    it("resolves old-style family-last IDs (claude-3-5-sonnet-20241022)", () => {
      const models = [
        makeModel(
          "claude-3-5-sonnet-20241022",
          "claude-sonnet-3.5",
          "claude-sonnet-3.5",
        ),
      ]
      const result = findInModels("claude-3-5-sonnet-20241022", models)
      expect(result?.id).toBe("claude-3-5-sonnet-20241022")
    })
  })

  describe("semantic tuple fallback", () => {
    // If Copilot changes their ID and version field formats again, the
    // semantic fallback normalizes both sides and compares {family, version}
    // tuples — no string format dependency.
    it("matches when m.id changes format but normalizes to the same tuple", () => {
      const models = [
        // Hypothetical future format: longer suffix, different separator style.
        makeModel(
          "claude-sonnet-4-6-2026-03-01-preview",
          "some-unrecognised-version-string",
          "claude-sonnet-4.6",
        ),
      ]
      // m.version won't match; semantic fallback normalizes m.capabilities.family
      // "claude-sonnet-4.6" → {family:"sonnet", version:"4.6"} and matches.
      const result = findInModels("claude-sonnet-4-6", models)
      expect(result?.id).toBe("claude-sonnet-4-6-2026-03-01-preview")
    })

    it("matches via m.id normalization when version and family are unrecognised", () => {
      const models = [
        makeModel("claude-haiku-4-5-20260301", "unrecognised", "unrecognised"),
      ]
      const result = findInModels("claude-haiku-4-5", models)
      expect(result?.id).toBe("claude-haiku-4-5-20260301")
    })

    // Kills the BooleanLiteral mutation that turns `if (!c) return false`
    // into `if (!c) return true`, and the ConditionalExpression that turns
    // `if (!c)` into `if (false)` (which causes a TypeError on c.family).
    // The opaque model forces c=undefined in the predicate; the target uses
    // an unrecognised version string so byName doesn't short-circuit and the
    // semantic fallback actually runs.
    it("skips models whose fields cannot be normalised, returns the correct one", () => {
      const opaque = makeModel("opaque-id", "opaque-version", "opaque-family")
      // version is opaque so byName (m.version === modelName) fails;
      // semantic fallback must find it via capabilities.family.
      const target = makeModel(
        "claude-sonnet-4-6-20260301",
        "unrecognised",
        "claude-sonnet-4.6",
      )
      const result = findInModels("claude-sonnet-4-6", [opaque, target])
      expect(result?.id).toBe("claude-sonnet-4-6-20260301")
    })

    // Kills the ConditionalExpression mutation that replaces
    // `c.family === normalized.family && c.version === normalized.version`
    // with `true && c.version === normalized.version` (drops family check).
    // opus-4.6 appears before sonnet-4.6; without the family guard the
    // wrong model would be returned.
    it("distinguishes models with the same version but different family", () => {
      const opusFirst = makeModel(
        "claude-opus-4-6-20260301",
        "unrecognised",
        "claude-opus-4.6",
      )
      const sonnet = makeModel(
        "claude-sonnet-4-6-20260301",
        "unrecognised",
        "claude-sonnet-4.6",
      )
      const result = findInModels("claude-sonnet-4-6", [opusFirst, sonnet])
      expect(result?.id).toBe("claude-sonnet-4-6-20260301")
    })
  })

  describe("no match", () => {
    it("returns undefined for a non-Claude model ID not in the list", () => {
      expect(findInModels("gpt-5.4", CURRENT_MODELS)).toBeUndefined()
    })

    it("returns undefined when no model in the list matches", () => {
      expect(findInModels("claude-opus-99-0", CURRENT_MODELS)).toBeUndefined()
    })
  })
})

describe("normalizeSdkModelId", () => {
  describe("known SDK formats (happy path)", () => {
    it.each([
      // Pattern 1: claude-{family}-{major}-{minor}[-date]
      ["claude-opus-4-5-20251101", { family: "opus", version: "4.5" }],
      ["claude-haiku-3-5-20250514", { family: "haiku", version: "3.5" }],
      ["claude-sonnet-4-6", { family: "sonnet", version: "4.6" }],
      ["claude-sonnet-4-6-20260301", { family: "sonnet", version: "4.6" }],
      // Pattern 2: claude-{major}-{minor}-{family}[-date]
      ["claude-3-5-sonnet-20241022", { family: "sonnet", version: "3.5" }],
      // Pattern 3: claude-{family}-{major}.{minor}
      ["claude-haiku-4.5", { family: "haiku", version: "4.5" }],
      ["claude-sonnet-4.6", { family: "sonnet", version: "4.6" }],
      // Pattern 4: claude-{family}-{major}[-date]
      ["claude-sonnet-4-20250514", { family: "sonnet", version: "4" }],
      // Pattern 5: claude-{major}-{family}
      ["claude-3-opus", { family: "opus", version: "3" }],
    ])(
      "%s → %o",
      (
        input: string,
        expected: { family: string; version: string } | undefined,
      ) => {
        expect(normalizeSdkModelId(input)).toEqual(expected)
      },
    )
  })

  // Multi-digit version segments — kills \d+ → \d mutations on every pattern.
  describe("multi-digit version segments", () => {
    it.each([
      // Pattern 1: two-digit major
      ["claude-opus-10-5", { family: "opus", version: "10.5" }],
      // Pattern 1: two-digit minor
      ["claude-opus-4-10", { family: "opus", version: "4.10" }],
      // Pattern 2: two-digit major
      ["claude-10-5-opus", { family: "opus", version: "10.5" }],
      // Pattern 2: two-digit minor
      ["claude-3-10-opus", { family: "opus", version: "3.10" }],
      // Pattern 3: two-digit major
      ["claude-opus-10.5", { family: "opus", version: "10.5" }],
      // Pattern 3: two-digit minor
      ["claude-opus-4.10", { family: "opus", version: "4.10" }],
      // Pattern 4: two-digit major
      ["claude-opus-10", { family: "opus", version: "10" }],
      // Pattern 5: two-digit major
      ["claude-10-opus", { family: "opus", version: "10" }],
    ])(
      "%s → %o",
      (
        input: string,
        expected: { family: string; version: string } | undefined,
      ) => {
        expect(normalizeSdkModelId(input)).toEqual(expected)
      },
    )
  })

  // ^ anchor — strings that don't start with "claude-" must not match.
  // Kills the ^ → (removed) mutations on each of the five patterns.
  describe("^ anchor: rejects strings not starting with claude-", () => {
    it.each([
      "prefix-claude-sonnet-4-6", // would match Pattern 1 without ^
      "prefix-claude-3-5-sonnet", // would match Pattern 2 without ^
      "prefix-claude-haiku-4.5", // would match Pattern 3 without ^
      "prefix-claude-sonnet-4", // would match Pattern 4 without ^
      "prefix-claude-3-opus", // would match Pattern 5 without ^
    ])("%s → undefined", (input: string) => {
      expect(normalizeSdkModelId(input)).toBeUndefined()
    })
  })

  // $ anchor — strings with trailing garbage after the version must not match.
  // Kills the $ → (removed) mutations on each pattern.
  describe("$ anchor: rejects strings with non-version trailing content", () => {
    it.each([
      "claude-sonnet-4-6-extra", // would match Pattern 1 without $
      "claude-3-5-sonnet-extra", // would match Pattern 2 without $
      "claude-haiku-4.5-extra", // would match Pattern 3 without $
      "claude-sonnet-4-extra", // would match Pattern 4 without $
      "claude-3-opus-extra", // would match Pattern 5 without $
    ])("%s → undefined", (input: string) => {
      expect(normalizeSdkModelId(input)).toBeUndefined()
    })
  })

  // Date-strip $ anchor — ensures the 8-digit strip is anchored to the end,
  // so a date-like segment in the middle (e.g. as the major version) is
  // preserved rather than stripped. Without the $ the middle segment is
  // consumed, destroying the version information.
  describe("date-strip $ anchor: preserves date-like middle segments", () => {
    it("treats an 8-digit major version as the version number, not a date", () => {
      // "-20241022" appears in the middle: Pattern 5 captures it as the version.
      // Without the $ anchor on the strip regex, the middle segment is eaten
      // and the string becomes "claude--opus" which matches nothing.
      expect(normalizeSdkModelId("claude-20241022-opus")).toEqual({
        family: "opus",
        version: "20241022",
      })
    })
  })

  describe("non-Claude IDs", () => {
    it.each(["gpt-5.4", "gemini-pro", "gpt-4o", ""])(
      "%s → undefined",
      (input: string) => {
        expect(normalizeSdkModelId(input)).toBeUndefined()
      },
    )
  })
})

// ---------------------------------------------------------------------------
// findEndpointModel — the one-line state-reading wrapper. Previously tested
// only "via route integration tests" per the now-removed comment, but
// tests/messages-handler.test.ts mock.module's the whole module out so the
// wrapper had ZERO surviving mutation coverage. Mutation testing surfaced 11
// surviving mutants in this function — all killed by the tests below.
// ---------------------------------------------------------------------------

describe("findEndpointModel", () => {
  const originalModels = state.models

  beforeEach(() => {
    state.models = undefined
  })

  afterEach(() => {
    state.models = originalModels
  })

  it("returns undefined when state.models is undefined (the ?? [] fallback)", () => {
    state.models = undefined
    // Kills OptionalChaining mutant `state.models.data` (would NPE) and
    // LogicalOperator mutant `state.models?.data && []` (returns undefined
    // when models is undefined and asks findInModels to search undefined).
    expect(findEndpointModel("claude-sonnet-4-6")).toBeUndefined()
  })

  it("returns undefined when state.models.data is empty (the ?? [] fallback path is exercised)", () => {
    state.models = {
      data: [],
      object: "list",
    }
    expect(findEndpointModel("claude-sonnet-4-6")).toBeUndefined()
  })

  it("rejects the 'Stryker was here' poisoned fallback — [] really means []", () => {
    // Kills the ArrayDeclaration mutant `?? ["Stryker was here"]`. If the
    // fallback array contained junk, findInModels would still return
    // undefined here because none of the junk matches "claude-...". But the
    // intent is documented: a fallback to literal [], not a fallback to
    // arbitrary garbage that happens to also return undefined.
    state.models = undefined
    const result = findEndpointModel("claude-sonnet-4-6")
    expect(result).toBeUndefined()
    // The function must not throw on a string-array fallback either —
    // findInModels only safely consumes Model[]. The poisoned-fallback
    // mutant would crash; an undefined return + no throw is the spec.
  })

  it("resolves a model from state.models.data by passing through to findInModels", () => {
    // Kills the ArrowFunction mutant `findEndpointModel = () => undefined`
    // and the ArrowFunction mutant on findInModels callbacks. The real
    // wrapper must return the matching model from state.
    const model = {
      capabilities: {
        family: "claude-sonnet-4.6",
        limits: {},
        object: "model_capabilities" as const,
        supports: {},
        tokenizer: "o200k_base",
        type: "chat" as const,
      },
      id: "claude-sonnet-4-6-20260301",
      model_picker_enabled: true,
      name: "Sonnet 4.6",
      object: "model" as const,
      preview: false,
      vendor: "Anthropic",
      version: "claude-sonnet-4.6",
      supported_endpoints: ["/v1/messages"],
    }
    state.models = { data: [model], object: "list" }

    // Exact-match path.
    expect(findEndpointModel("claude-sonnet-4-6-20260301")?.id).toBe(
      "claude-sonnet-4-6-20260301",
    )
    // byName path (kills the StringLiteral mutant `modelName = ""` and the
    // ConditionalExpression mutants on the m.id/m.version predicate, plus
    // the `if (byName) return byName` early-return mutant).
    expect(findEndpointModel("claude-sonnet-4-6")?.id).toBe(
      "claude-sonnet-4-6-20260301",
    )
    expect(findEndpointModel("claude-sonnet-4.6")?.id).toBe(
      "claude-sonnet-4-6-20260301",
    )
  })

  it("passes the sdkModelId argument through unchanged (not a constant)", () => {
    // The wrapper passes sdkModelId straight to findInModels. A mutant that
    // hardcodes the argument would resolve the wrong (or no) model.
    const a = {
      capabilities: {
        family: "claude-opus-4.6",
        limits: {},
        object: "model_capabilities" as const,
        supports: {},
        tokenizer: "o200k_base",
        type: "chat" as const,
      },
      id: "claude-opus-4-6-20260301",
      model_picker_enabled: true,
      name: "Opus",
      object: "model" as const,
      preview: false,
      vendor: "Anthropic",
      version: "claude-opus-4.6",
      supported_endpoints: ["/v1/messages"],
    }
    const b = {
      ...a,
      id: "claude-haiku-4-5-20260301",
      version: "claude-haiku-4.5",
      capabilities: { ...a.capabilities, family: "claude-haiku-4.5" },
    }
    state.models = { data: [a, b], object: "list" }

    expect(findEndpointModel("claude-opus-4-6")?.id).toBe(
      "claude-opus-4-6-20260301",
    )
    expect(findEndpointModel("claude-haiku-4-5")?.id).toBe(
      "claude-haiku-4-5-20260301",
    )
  })

  // ------------------------------------------------------------------------
  // byName lookup — must kill the remaining `||` / `if (byName)` mutants.
  //
  // The synthesized lookup `(m) => m.id === modelName || m.version === modelName`
  // is symmetric in m.id vs m.version. Existing tests only exercise the
  // m.version branch (Copilot IDs in the wild are date-suffixed, so m.id
  // never equals the dot-normalized modelName). Stryker's
  //   `m.id === modelName || false`  mutation survives without a fixture
  // where m.id is the matching field.
  //
  // These tests add the missing fixtures so each disjunct's removal is
  // observable, and the `if (byName) return byName` early-return mutant
  // dies (a model found by byName must NOT round-trip through the
  // semantic-fallback to find a DIFFERENT model).
  // ------------------------------------------------------------------------

  it("byName matches via m.id when m.version doesn't match (kills `false || m.version` mutant)", () => {
    // Hypothetical fixture: a model with no date suffix on its id. The
    // synthesized modelName "claude-sonnet-4.6" matches m.id exactly,
    // and m.version is unrecognized so semantic fallback can't find it.
    const idMatchOnly = {
      capabilities: {
        family: "unrecognised",
        limits: {},
        object: "model_capabilities" as const,
        supports: {},
        tokenizer: "o200k_base",
        type: "chat" as const,
      },
      id: "claude-sonnet-4.6",
      model_picker_enabled: true,
      name: "Sonnet 4.6 (no date)",
      object: "model" as const,
      preview: false,
      vendor: "Anthropic",
      version: "unrecognised",
      supported_endpoints: ["/v1/messages"],
    }
    state.models = { data: [idMatchOnly], object: "list" }
    const result = findEndpointModel("claude-sonnet-4-6")
    expect(result?.id).toBe("claude-sonnet-4.6")
  })

  it("byName matches via m.version when m.id is unrelated (kills `m.id || false` mutant)", () => {
    // Inverse of the above: m.id is opaque, m.version is the dot-normalized
    // modelName. Existing tests cover this via CURRENT_MODELS, but assert
    // through findInModels — add an explicit findEndpointModel assertion
    // so Stryker's per-mutant test mapping connects the wrapper to the
    // surviving mutant.
    const versionMatchOnly = {
      capabilities: {
        family: "unrecognised",
        limits: {},
        object: "model_capabilities" as const,
        supports: {},
        tokenizer: "o200k_base",
        type: "chat" as const,
      },
      id: "opaque-id-no-pattern",
      model_picker_enabled: true,
      name: "Sonnet via version",
      object: "model" as const,
      preview: false,
      vendor: "Anthropic",
      version: "claude-sonnet-4.6",
      supported_endpoints: ["/v1/messages"],
    }
    state.models = { data: [versionMatchOnly], object: "list" }
    const result = findEndpointModel("claude-sonnet-4-6")
    expect(result?.id).toBe("opaque-id-no-pattern")
  })

  it("`if (byName) return byName` early-returns and does NOT fall through to semantic fallback", () => {
    // Two models match the query:
    //   - byNameWinner: m.version === "claude-sonnet-4.6" (byName hit)
    //   - semanticWinner: m.capabilities.family === "claude-sonnet-4.6"
    //     (would be returned by the semantic-tuple fallback if byName
    //     didn't short-circuit)
    // The contract is that byName wins. If `if (byName) return byName` is
    // mutated to `if (false) return byName`, the function falls through and
    // returns the OTHER model — this test asserts the actual winner is
    // byNameWinner.
    const byNameWinner = {
      capabilities: {
        family: "unrecognised",
        limits: {},
        object: "model_capabilities" as const,
        supports: {},
        tokenizer: "o200k_base",
        type: "chat" as const,
      },
      id: "winner-by-version",
      model_picker_enabled: true,
      name: "byName winner",
      object: "model" as const,
      preview: false,
      vendor: "Anthropic",
      version: "claude-sonnet-4.6",
      supported_endpoints: ["/v1/messages"],
    }
    const semanticWinner = {
      ...byNameWinner,
      id: "would-win-semantic",
      version: "unrecognised",
      capabilities: {
        ...byNameWinner.capabilities,
        family: "claude-sonnet-4.6",
      },
    }
    state.models = {
      data: [byNameWinner, semanticWinner],
      object: "list",
    }
    const result = findEndpointModel("claude-sonnet-4-6")
    expect(result?.id).toBe("winner-by-version")
  })

  it("byName uses `||` not `&&` (kills LogicalOperator mutant)", () => {
    // The `||` mutated to `&&` requires BOTH m.id and m.version to equal
    // modelName for a match. With a fixture where ONLY m.version matches
    // (m.id is opaque), the `&&` mutant returns no byName hit and falls
    // through to semantic fallback — which can't find this model either
    // (m.capabilities.family is opaque). The real `||` returns the model;
    // the mutant returns undefined.
    const versionOnly = {
      capabilities: {
        family: "opaque-family",
        limits: {},
        object: "model_capabilities" as const,
        supports: {},
        tokenizer: "o200k_base",
        type: "chat" as const,
      },
      id: "opaque-id",
      model_picker_enabled: true,
      name: "version-only match",
      object: "model" as const,
      preview: false,
      vendor: "Anthropic",
      version: "claude-haiku-4.5",
      supported_endpoints: ["/v1/messages"],
    }
    state.models = { data: [versionOnly], object: "list" }
    const result = findEndpointModel("claude-haiku-4-5")
    expect(result?.id).toBe("opaque-id")
  })
})
