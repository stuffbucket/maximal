import type { Model } from "~/services/copilot/get-models"

function identityParts(model: Model): {
  id: string
  family: string
  vendor: string
} {
  const sparse = model as {
    id?: unknown
    vendor?: unknown
    capabilities?: { family?: unknown }
  }
  return {
    id: typeof sparse.id === "string" ? sparse.id.toLowerCase() : "",
    family:
      typeof sparse.capabilities?.family === "string" ?
        sparse.capabilities.family.toLowerCase()
      : "",
    vendor:
      typeof sparse.vendor === "string" ? sparse.vendor.toLowerCase() : "",
  }
}

export function isClaudeTierClass(
  model: Model,
  tier: "haiku" | "sonnet",
): boolean {
  const { id, family } = identityParts(model)
  const isClaude = family.includes("claude") || id.startsWith("claude")
  return isClaude && (family.includes(tier) || id.includes(tier))
}

export function isGptClass(model: Model): boolean {
  const { id, family, vendor } = identityParts(model)
  return (
    id.startsWith("gpt") || family.includes("gpt") || vendor.includes("openai")
  )
}

const SMALL_CLASS_TOKEN = /(?:^|[-_.\s])(?:mini|nano|small)(?:$|[-_.\s])/u

/** True when a model id or family carries a bounded `mini`, `nano` or `small`
 *  token (so `gpt-5-mini` matches but `gemini` and `gpt-minimal` don't). */
export function isSmallClassName(name: string): boolean {
  return SMALL_CLASS_TOKEN.test(name.toLowerCase())
}

export function isSmallGptClass(model: Model): boolean {
  if (!isGptClass(model)) return false
  const { id, family } = identityParts(model)
  return isSmallClassName(id) || isSmallClassName(family)
}
