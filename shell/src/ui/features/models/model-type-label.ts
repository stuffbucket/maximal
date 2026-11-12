const MODEL_TYPE_LABELS = new Map<string, string>([
  ["chat", "Chat models"],
  ["decisions", "Decision models"],
  ["embeddings", "Embeddings"],
  ["image", "Image models"],
]);

/**
 * Human label for a model catalog `capabilities.type`. The wire contract is
 * intentionally open to provider additions, so unknown values are humanized
 * rather than dropped or rendered as a blank disclosure.
 */
export function modelTypeLabel(type: string): string {
  const normalized = type.trim();
  const known = MODEL_TYPE_LABELS.get(normalized);
  if (known) return known;
  if (!normalized) return "Other models";
  const words = normalized.replace(/[-_\s]+/gu, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
