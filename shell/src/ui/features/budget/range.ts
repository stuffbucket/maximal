/**
 * The range pickers' model, shared by Activity, a rule's timeline and the
 * what-if preview: a named trailing range (`24h` to `all`) or a custom pair of
 * UTC days. Free of the DOM and the catalog so it can be tested on its own.
 *
 * The API counts in UTC and takes `to` exclusive, so a custom range is two
 * whole days: it starts at 00:00 UTC on `from` and runs through the end of
 * `to`, which is the picked day inclusive, as people read "Nov 1 to Nov 8".
 */

export type RangePreset = "24h" | "7d" | "30d" | "90d" | "all";
export type RangeKind = RangePreset | "custom";

/** What a range picker holds: the kind, and the custom days (kept when a preset is picked, so Custom reopens where it was). */
export interface RangeChoice {
  range: RangeKind;
  /** `YYYY-MM-DD`, UTC; empty when the field is cleared. */
  from: string;
  /** `YYYY-MM-DD`, UTC, inclusive; empty when the field is cleared. */
  to: string;
}

export const RANGE_PRESETS: ReadonlyArray<RangePreset> = ["24h", "7d", "30d", "90d", "all"];

const DAY_MS = 86_400_000;

/** A `YYYY-MM-DD` day (UTC) for a moment. */
export function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** A choice of `range`, with custom days that start as the last week so Custom opens on something sensible. */
export function rangeChoice(range: RangeKind, nowMs: number): RangeChoice {
  return { range, from: utcDayKey(nowMs - 6 * DAY_MS), to: utcDayKey(nowMs) };
}

function dayStartMs(day: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) return null;
  const ms = Date.parse(`${day}T00:00:00Z`);
  return Number.isNaN(ms) ? null : ms;
}

/** The custom days as `[from, to)` in ms, or null while either is missing or they run backwards. */
export function customSpan(choice: Pick<RangeChoice, "from" | "to">): { fromMs: number; toMs: number } | null {
  const fromMs = dayStartMs(choice.from);
  const toDay = dayStartMs(choice.to);
  if (fromMs === null || toDay === null || toDay < fromMs) return null;
  return { fromMs, toMs: toDay + DAY_MS };
}

/** Whether the choice names a range the API can answer (a custom one needs two days in order). */
export function isRangeReady(choice: RangeChoice): boolean {
  return choice.range !== "custom" || customSpan(choice) !== null;
}

/** The query pairs that select the range (`range=7d`, or `from`/`to`), or null while a custom range is incomplete. */
export function rangeParams(choice: RangeChoice): Array<[string, string]> | null {
  if (choice.range !== "custom") return [["range", choice.range]];
  const span = customSpan(choice);
  if (!span) return null;
  return [
    ["from", new Date(span.fromMs).toISOString()],
    ["to", new Date(span.toMs).toISOString()],
  ];
}

/** The range as the report endpoints' request bodies name it (`"30d"` or `{ from, to }`), or null while incomplete. */
export function rangeBody(choice: RangeChoice): RangePreset | { from: string; to: string } | null {
  if (choice.range !== "custom") return choice.range;
  const span = customSpan(choice);
  return span ? { from: new Date(span.fromMs).toISOString(), to: new Date(span.toMs).toISOString() } : null;
}

/** The range as it reads in a file name: `7d`, or `2026-11-01_to_2026-11-08`. */
export function rangeFileLabel(choice: RangeChoice): string {
  return choice.range === "custom" ? `${choice.from}_to_${choice.to}` : choice.range;
}
