/**
 * Pure display formatters for the Usage section (spec §4), ported verbatim from
 * the standalone dashboard's render helpers so the numbers read identically. No
 * DOM, no i18n — unit-tested in `tests/usage-format.test.ts`. The React `Usage`
 * feature composes these; the exhaustive tables/meters live in `Usage.tsx`.
 */

/** `total_nano_aiu` is billed in nano-AIU; 1 AIU = 1e9 nano-AIU. */
const NANO_AIU_PER_AIU = 1_000_000_000;

/** Locale-grouped integer, e.g. 1234567 → "1,234,567"; non-finite → "0". */
export function formatNumber(value: number): string {
  return Number.isFinite(value) ? Number(value).toLocaleString() : "0";
}

/**
 * Human cost in AIU. Zero/absent cost is common (many models bill nothing here),
 * so render an em dash rather than "0.000 AIU"/"NaN" (design failure-modes rule).
 * Small values need more digits; trailing zeros are trimmed.
 */
export function formatCostAiu(nanoAiu: number): string {
  if (!Number.isFinite(nanoAiu) || nanoAiu <= 0) {
    return "—";
  }
  const aiu = nanoAiu / NANO_AIU_PER_AIU;
  const digits = aiu < 1 ? 4 : 3;
  const text = aiu.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
  return `${text} AIU`;
}

/** A table cell that is a non-empty trimmed string, or an em dash otherwise. */
export function formatCellText(value: unknown): string {
  if (typeof value !== "string") {
    return "—";
  }
  return value.trim() || "—";
}

/** "used / entitlement" quota text; unlimited entitlement shows ∞. */
export function formatQuotaUsed(
  entitlement: number,
  remaining: number,
  unlimited: boolean,
): string {
  if (unlimited) return "0";
  return Math.max(0, entitlement - remaining).toLocaleString();
}
