/**
 * The Budget window's number, time and grouping logic, free of the DOM and of
 * the i18n catalog so it can be tested on its own (tests/budget-format.test.ts).
 * Components pass the locale in and wrap these results in catalog strings.
 *
 * Amounts arrive already in the display unit (`display.limit`, `amount`); only
 * the figures the API gives in nano-AIU (`held`) are converted here, with the
 * same arithmetic as `src/lib/budget/units.ts`.
 */

import type {
  BudgetActivityResponse,
  BudgetLimitPutRequest,
  BudgetLimitStatus,
  BudgetStatusResponse,
  ProviderQuotaWindowStatus,
} from "../../../../../src/lib/config/settings-types";

export type DisplayInfo = BudgetStatusResponse["display"];
export type DisplayUnit = DisplayInfo["unit"];
export type BudgetScope = BudgetLimitStatus["scope"];
export type LimitReset = BudgetLimitStatus["limit_reset"];
export type ActivityRow = BudgetActivityResponse["rows"][number];
export type ActivityPeriod = BudgetActivityResponse["period"];
export type ActivityGroup = BudgetActivityResponse["group"];

export const ACTIVITY_PERIODS: ReadonlyArray<ActivityPeriod> = ["day", "week", "month"];
export const ACTIVITY_GROUPS: ReadonlyArray<ActivityGroup> = ["model", "plugin", "key", "provider", "day"];

const NANO_AIU_PER_CREDIT = 1_000_000_000;

/** A nano-AIU figure in the display unit (US dollars or AI credits). */
export function nanoToDisplay(nanoAiu: number, display: DisplayInfo): number {
  const credits = nanoAiu / NANO_AIU_PER_CREDIT;
  return display.unit === "usd" ? credits * display.credit_usd : credits;
}

/**
 * Decimal places that keep two significant digits of a small amount ($0.006
 * must not read $0.01), never fewer than two and never more than six.
 */
function fractionDigits(value: number): number {
  const magnitude = Math.abs(value);
  if (magnitude === 0 || magnitude >= 1) return 2;
  return Math.min(6, Math.max(2, Math.ceil(-Math.log10(magnitude)) + 1));
}

/**
 * An amount for people: `$2.40` for US dollars, a bare number for AI credits
 * (the caller adds the unit through its catalog so word order stays
 * translatable). Small amounts keep their significant digits.
 */
export function formatAmount(value: number, unit: DisplayUnit, locale: string): string {
  const digits = fractionDigits(value);
  const options: Intl.NumberFormatOptions = { minimumFractionDigits: 2, maximumFractionDigits: digits };
  if (unit === "usd") {
    return new Intl.NumberFormat(locale, { ...options, style: "currency", currency: "USD" }).format(value);
  }
  return new Intl.NumberFormat(locale, options).format(value);
}

/** How full the limit is, 0 to 1. A limit of zero is full as soon as anything is spent. */
export function usedFraction(usage: number, limit: number): number {
  if (limit <= 0) return usage > 0 ? 1 : 0;
  return Math.min(1, Math.max(0, usage / limit));
}

export type MeterTone = "ok" | "warning" | "exhausted";

/**
 * How much of a provider's allowance is used, 0 to 1, or null when the
 * provider reported neither a percentage nor counters. The percentage is the
 * provider's own (`percent_remaining`, 0 to 100); counters are the fallback.
 */
export function windowUsedFraction(
  window: Pick<ProviderQuotaWindowStatus, "percent_remaining" | "used" | "limit">,
): number | null {
  if (window.percent_remaining !== null) {
    return Math.min(1, Math.max(0, (100 - window.percent_remaining) / 100));
  }
  if (window.used !== null && window.limit !== null && window.limit > 0) {
    return usedFraction(window.used, window.limit);
  }
  return null;
}

/** The Dashboard's quota steps: warning from 75% used, error from 90%. */
export function windowTone(fractionUsed: number): MeterTone {
  if (fractionUsed >= 0.9) return "exhausted";
  if (fractionUsed >= 0.75) return "warning";
  return "ok";
}

// ── Time ────────────────────────────────────────────────────────────────

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** "in 3 hours", "in 3 weeks", "2 days ago", in the person's language. */
export function formatRelative(targetMs: number, nowMs: number, locale: string): string {
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const delta = targetMs - nowMs;
  const span = Math.abs(delta);
  const sign = Math.sign(delta) || 1;
  if (span < HOUR_MS) return formatter.format(sign * Math.max(1, Math.round(span / MINUTE_MS)), "minute");
  if (span < 2 * DAY_MS) return formatter.format(sign * Math.round(span / HOUR_MS), "hour");
  if (span < 14 * DAY_MS) return formatter.format(sign * Math.round(span / DAY_MS), "day");
  if (span < 60 * DAY_MS) return formatter.format(sign * Math.round(span / (7 * DAY_MS)), "week");
  return formatter.format(sign * Math.round(span / (30 * DAY_MS)), "month");
}

/** "Dec 1, 1:00 AM", with the year only when it isn't this one. */
export function formatWhen(targetMs: number, nowMs: number, locale: string): string {
  const sameYear = new Date(targetMs).getFullYear() === new Date(nowMs).getFullYear();
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  }).format(targetMs);
}

/** A `YYYY-MM-DD` day key (UTC, as the API groups days) as "Nov 10". */
export function formatDayKey(key: string, locale: string): string {
  const [year, month, day] = key.split("-").map(Number);
  if (!year || !month || !day) return key;
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone: "UTC" }).format(
    Date.UTC(year, month - 1, day),
  );
}

/** The start of an activity period as "Nov 10", in UTC like the period itself. */
export function formatPeriodStart(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone: "UTC" }).format(Date.parse(iso));
}

// ── Limits ──────────────────────────────────────────────────────────────

/** `<provider>:<window>` of the window a limit follows, or null. */
export function followedWindow(reset: LimitReset): string | null {
  return typeof reset === "object" ? reset.follow : null;
}

/** The provider's window a `<provider>:<window>` reference names, if it has reported one. */
export function findWindow(
  windows: ReadonlyArray<ProviderQuotaWindowStatus>,
  ref: string,
): ProviderQuotaWindowStatus | undefined {
  return windows.find((window) => `${window.provider}:${window.id}` === ref);
}

export type ResetDescription =
  | { kind: "never" }
  | { kind: "at"; resetsAtMs: number; estimated: boolean }
  /** Follows a provider window; `window` is its label when it has reported one. */
  | { kind: "follow"; resetsAtMs: number; estimated: boolean; window: string }
  /** Followed a window that has no usable reset, so it resets daily instead. */
  | { kind: "fallback"; resetsAtMs: number; window: string };

/** What a limit's reset reads as, before wording: the component picks the sentence. */
export function describeReset(
  limit: Pick<BudgetLimitStatus, "limit_reset" | "resets_at" | "reset_basis" | "reset_estimated">,
  windows: ReadonlyArray<ProviderQuotaWindowStatus>,
): ResetDescription {
  const ref = followedWindow(limit.limit_reset);
  const resetsAtMs = limit.resets_at ? Date.parse(limit.resets_at) : Number.NaN;
  if (Number.isNaN(resetsAtMs)) return { kind: "never" };
  const windowName = ref ? (findWindow(windows, ref)?.label ?? ref) : "";
  if (ref && limit.reset_basis === "fallback") return { kind: "fallback", resetsAtMs, window: windowName };
  if (ref) return { kind: "follow", resetsAtMs, estimated: limit.reset_estimated, window: windowName };
  return { kind: "at", resetsAtMs, estimated: limit.reset_estimated };
}

/** A limit's `usage` as the whole it is measured against: the held spend counts as used room. */
export function limitFigures(
  limit: BudgetLimitStatus,
  display: DisplayInfo,
): { usage: number; limit: number; remaining: number; held: number } {
  return {
    usage: limit.display.usage,
    limit: limit.display.limit,
    remaining: limit.display.limit_remaining,
    held: nanoToDisplay(limit.held, display),
  };
}

/** The scope as a key for lookups and ids: `global`, `key:codex`. */
export function scopeKey(scope: BudgetScope): string {
  return scope.kind === "global" ? "global" : `${scope.kind}:${scope.id}`;
}

/** The limit that stops requests first (`effective_budget`), when it is already spent. */
export function blockingLimit(status: BudgetStatusResponse): BudgetLimitStatus | undefined {
  if (!status.enabled || !status.effective_budget) return undefined;
  const limit = status.budgets.find((candidate) => candidate.id === status.effective_budget);
  return limit?.state === "exhausted" && limit.action === "block" ? limit : undefined;
}

// ── The editor ──────────────────────────────────────────────────────────

/** Clients Maximal recognises without a key label (`deriveUsageClient`). */
export const KNOWN_CLIENTS: ReadonlyArray<string> = ["claude-code", "claude-desktop", "codex", "unidentified"];

/** Capabilities Maximal serves itself; their spend records `plugin_id` as the capability. */
export const BUILT_IN_CAPABILITIES: ReadonlyArray<string> = ["images", "decisions", "systemone"];

/** The providers a limit can name: Copilot, plus any that have reported a window. */
export function providerChoices(windows: ReadonlyArray<ProviderQuotaWindowStatus>): Array<string> {
  return unique(["copilot", ...windows.map((window) => window.provider)]);
}

/** Client keys a limit can name: the keys that exist, then the clients Maximal recognises. */
export function keyChoices(keyLabels: ReadonlyArray<string>): Array<string> {
  return unique([...keyLabels, ...KNOWN_CLIENTS]);
}

/** Plugins a limit can name: the built-in capabilities, then installed plugins. */
export function pluginChoices(pluginIds: ReadonlyArray<string>): Array<string> {
  return unique([...BUILT_IN_CAPABILITIES, ...pluginIds]);
}

function unique(values: ReadonlyArray<string>): Array<string> {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value !== ""))];
}

/** A limit's id: lowercase words joined by `-`, never one already taken. */
export function newLimitId(
  scope: BudgetScope,
  reset: LimitReset,
  taken: ReadonlyArray<string>,
): string {
  const resetWord = typeof reset === "object" ? "cycle" : reset;
  const parts = scope.kind === "global" ? ["everything"] : [scope.kind, scope.id];
  const base =
    [...parts, resetWord]
      .join("-")
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 56) || "limit";
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

/** The reset select's value for a limit: `daily`, `weekly`, `never` or `follow:<ref>`. */
export function resetChoice(reset: LimitReset): string {
  return typeof reset === "object" ? `follow:${reset.follow}` : reset;
}

/** The inverse of `resetChoice`; unknown text reads as `daily`. */
export function resetFromChoice(choice: string): LimitReset {
  if (choice.startsWith("follow:")) return { follow: choice.slice("follow:".length) };
  return choice === "weekly" || choice === "never" ? choice : "daily";
}

/** What the person typed in the amount field: a number above zero, or null. */
export function parseAmount(text: string): number | null {
  const value = Number(text.trim().replace(",", "."));
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** The warning percentage the person typed (1 to 100) as the API's 0..1 fraction, or null. */
export function parseWarnPercent(text: string): number | null {
  const value = Number(text.trim());
  if (!Number.isFinite(value) || value < 1 || value > 100) return null;
  return Math.round(value) / 100;
}

/** The API's 0..1 warning fraction as the whole percent the field shows. */
export function warnPercentText(fraction: number): string {
  return String(Math.round(fraction * 100));
}

export interface LimitForm {
  label: string;
  scopeKind: BudgetScope["kind"];
  /** The key, plugin or provider the scope names; ignored for `global`. */
  scopeId: string;
  amount: string;
  reset: string;
  warnPercent: string;
  action: BudgetLimitPutRequest["action"];
}

export type LimitFormIssue = "amount" | "warn" | "target";

/**
 * The request for a form, or the first problem with it. The amount is sent in
 * the display unit (`amount`); the server converts and stores nano-AIU.
 */
export function buildPutRequest(
  form: LimitForm,
): { ok: true; body: BudgetLimitPutRequest } | { ok: false; issue: LimitFormIssue } {
  const amount = parseAmount(form.amount);
  if (amount === null) return { ok: false, issue: "amount" };
  const warnAt = parseWarnPercent(form.warnPercent);
  if (warnAt === null) return { ok: false, issue: "warn" };
  const targetId = form.scopeId.trim();
  if (form.scopeKind !== "global" && targetId === "") return { ok: false, issue: "target" };
  const label = form.label.trim();
  return {
    ok: true,
    body: {
      ...(label === "" ? {} : { label }),
      scope: form.scopeKind === "global" ? { kind: "global" } : { kind: form.scopeKind, id: targetId },
      amount,
      limit_reset: resetFromChoice(form.reset),
      warn_at: warnAt,
      action: form.action,
    },
  };
}

/** The amount field's starting text for an existing limit, in the display unit. */
export function amountText(value: number): string {
  // Trim float noise (0.30000000000000004) without losing real digits.
  return String(Number(value.toPrecision(10)));
}

// ── Activity ────────────────────────────────────────────────────────────

export interface ActivitySegment {
  /** The group's value, or null for rows that have none (no plugin, say). */
  key: string | null;
  /** True for the folded tail ("Other"). */
  other: boolean;
  amount: number;
  nanoAiu: number;
  requests: number;
  /** Share of the period's spend, 0 to 1. */
  share: number;
}

/**
 * The biggest `limit` rows by spend, with the rest folded into one "Other"
 * segment when there is more than one left over. Order is spend, biggest first.
 */
export function topSegments(rows: ReadonlyArray<ActivityRow>, limit: number): Array<ActivitySegment> {
  const total = rows.reduce((sum, row) => sum + row.nano_aiu, 0);
  const share = (nano: number): number => (total > 0 ? nano / total : 0);
  const ranked = [...rows].sort((a, b) => b.nano_aiu - a.nano_aiu);
  const asSegment = (row: ActivityRow): ActivitySegment => ({
    key: row.key,
    other: false,
    amount: row.amount,
    nanoAiu: row.nano_aiu,
    requests: row.requests,
    share: share(row.nano_aiu),
  });
  if (ranked.length <= limit) return ranked.map(asSegment);
  const shown = ranked.slice(0, limit - 1);
  const rest = ranked.slice(limit - 1);
  const nanoAiu = rest.reduce((sum, row) => sum + row.nano_aiu, 0);
  return [
    ...shown.map(asSegment),
    {
      key: null,
      other: true,
      amount: rest.reduce((sum, row) => sum + row.amount, 0),
      nanoAiu,
      requests: rest.reduce((sum, row) => sum + row.requests, 0),
      share: share(nanoAiu),
    },
  ];
}

/** The column height for a day, 0 to 1 of the tallest day. */
export function columnHeights(rows: ReadonlyArray<ActivityRow>): Array<number> {
  const max = rows.reduce((peak, row) => Math.max(peak, row.nano_aiu), 0);
  return rows.map((row) => (max > 0 ? row.nano_aiu / max : 0));
}

/** The query string the activity and CSV endpoints share. */
export function activityQuery(period: ActivityPeriod, group: ActivityGroup): string {
  return new URLSearchParams({ period, group }).toString();
}

/** A file name for the exported activity: `maximal-budget-model-week.csv`. */
export function csvFileName(period: ActivityPeriod, group: ActivityGroup): string {
  return `maximal-budget-${group}-${period}.csv`;
}
