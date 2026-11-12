import { t } from "../../../i18n";

const MODEL_TYPE_LABELS = new Map<string, string>([
  ["chat", "models-type-chat"],
  ["decisions", "models-type-decisions"],
  ["embeddings", "models-type-embeddings"],
  ["image", "models-type-image"],
]);

/**
 * Human label for a model catalog `capabilities.type`. The wire contract is
 * intentionally open to provider additions, so unknown values are humanized
 * rather than dropped or rendered as a blank disclosure.
 */
export function modelTypeLabel(type: string): string {
  const normalized = type.trim();
  const known = MODEL_TYPE_LABELS.get(normalized);
  if (known) return t(known);
  if (!normalized) return t("models-type-other");
  const words = normalized.replace(/[-_\s]+/gu, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
