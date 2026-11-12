/**
 * The Rules window's number, time and grouping logic, free of the DOM and of
 * the i18n catalog so it can be tested on its own (tests/budget-format.test.ts).
 * Components pass the locale in and wrap these results in catalog strings.
 *
 * Amounts arrive already in the rule's display unit (`display.limit`,
 * `amount`). Cost holds arrive in nano-AIU and are converted here; token holds
 * are already counts.
 */

import { type RangeChoice, rangeFileLabel, rangeParams } from "./range";

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
export type ActivityGroup = BudgetActivityResponse["group"];

export const ACTIVITY_GROUPS: ReadonlyArray<ActivityGroup> = ["model", "plugin", "key", "provider", "day", "hour"];

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
export function fractionDigits(value: number): number {
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

/**
 * A moment from the API in UTC, like everything it counts: "Nov 10" for a
 * midnight (the start of a day, week or month period), "Nov 10, 2:05 PM" for
 * any other, so a period that starts mid-day shows when. `withTime` always
 * shows the time, for a moment something happened.
 */
export function formatInstant(iso: string, locale: string, withTime = false): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const midnight = !withTime && ms % DAY_MS === 0;
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    ...(midnight ? {} : { hour: "numeric", minute: "2-digit" }),
    timeZone: "UTC",
  }).format(ms);
}

/** An hour key (`2026-11-11T14:00:00Z`, UTC, as the API groups hours) as "Nov 11, 2 PM". */
export function formatHourKey(key: string, locale: string): string {
  const ms = Date.parse(key);
  if (Number.isNaN(ms)) return key;
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "numeric", timeZone: "UTC" }).format(ms);
}

/**
 * A range as the Activity subtitle reads it, in UTC like the API counts: the
 * days it spans ("Nov 4 – Nov 11") or, for two days or less, the hours too.
 * `to` is exclusive, so a longer range that ends at midnight names the day before.
 */
export function formatSpan(fromIso: string, toIso: string, locale: string): string {
  const fromMs = Date.parse(fromIso);
  const toMs = Date.parse(toIso);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return "";
  const short = toMs - fromMs <= 2 * DAY_MS;
  const formatter = new Intl.DateTimeFormat(
    locale,
    short ?
      { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }
    : { month: "short", day: "numeric", timeZone: "UTC" },
  );
  return `${formatter.format(fromMs)} – ${formatter.format(short ? toMs : toMs - 1)}`;
}

// ── Limits ──────────────────────────────────────────────────────────────

/** `<provider>:<window>` of the window a limit follows, or null. */
export function followedWindow(reset: LimitReset): string | null {
  return typeof reset === "object" && "follow" in reset ? reset.follow : null;
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

/** A limit's conservative usage, with confirmed and uncertain parts kept
 * separate for display. */
export function limitFigures(
  limit: BudgetLimitStatus,
  display: DisplayInfo,
): { usage: number; confirmed: number; unreconciled: number; limit: number; remaining: number; held: number } {
  return {
    usage: limit.display.usage,
    confirmed: Math.max(0, limit.display.usage - limit.display.unreconciled),
    unreconciled: limit.display.unreconciled,
    limit: limit.display.limit,
    remaining: limit.display.limit_remaining,
    held: limit.unit === "tokens" ? limit.held : nanoToDisplay(limit.held, display),
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
  if (typeof reset === "string") return reset;
  // Rolling and monthly resets have no choice in this editor yet.
  return "follow" in reset ? `follow:${reset.follow}` : "daily";
}

/** The inverse of `resetChoice`; unknown text reads as `daily`. */
export function resetFromChoice(choice: string): LimitReset {
  if (choice.startsWith("follow:")) return { follow: choice.slice("follow:".length) };
  return choice === "weekly" || choice === "never" ? choice : "daily";
}

/** What the person typed in the amount field, and how it was read. */
export type AmountParse =
  | { ok: true; /** In the display unit. */ value: number }
  | { ok: false; reason: "format" | "zero" };

/** A currency sign or code, or a credit word, at either end of the amount. */
const UNIT_TOKEN = "(?:us\\$|[$€£¥₹₩₽₺₫฿₪₴₦₱]|usd|eur|gbp|jpy|cad|aud|chf|cny|inr|credits|credit|aiu|cr)";
const LEADING_UNIT = new RegExp(`^${UNIT_TOKEN}\\s*`, "iu");
const TRAILING_UNIT = new RegExp(`\\s*${UNIT_TOKEN}$`, "iu");
const CREDIT_WORDS = new Set(["credits", "credit", "aiu", "cr"]);

/** The unit a token names: AI credits, or money (which Maximal counts in dollars). */
function unitOfToken(token: string): DisplayUnit {
  return CREDIT_WORDS.has(token.trim().toLowerCase()) ? "credits" : "usd";
}

/** The locale's digit-group separator (a comma in en, a point in de). */
function groupSeparator(locale: string): string {
  try {
    const group = new Intl.NumberFormat(locale).formatToParts(1234567.5).find((part) => part.type === "group");
    return group?.value ?? ",";
  } catch {
    return ","; // an unknown locale reads like en
  }
}

/**
 * Plain digits with a "." decimal point from what was typed, or null. When
 * "," and "." both appear the last one is the decimal point. When only one
 * does, it is a thousands mark only if the locale groups with it and every
 * group is three digits ("1,000" is a thousand in en and 1.0 in de, while
 * "1,5" is one and a half anywhere); otherwise it is the decimal point.
 */
function normalizeNumber(raw: string, locale: string): string | null {
  const text = raw.replace(/[\s  '’]/gu, "");
  if (!/^[\d.,]+$/u.test(text)) return null;
  const lastDot = text.lastIndexOf(".");
  const lastComma = text.lastIndexOf(",");
  let integer: string;
  let fraction = "";
  if (lastDot !== -1 && lastComma !== -1) {
    const at = Math.max(lastDot, lastComma);
    const groupMark = lastDot > lastComma ? "," : ".";
    integer = text.slice(0, at).split(groupMark).join("");
    fraction = text.slice(at + 1);
  } else if (lastDot === -1 && lastComma === -1) {
    integer = text;
  } else {
    const mark = lastDot === -1 ? "," : ".";
    const parts = text.split(mark);
    const head = parts[0] ?? "";
    const grouped = head !== "" && head !== "0" && parts.slice(1).every((part) => part.length === 3);
    if (parts.length > 2) {
      if (!grouped) return null;
      integer = parts.join("");
    } else if (mark === groupSeparator(locale) && grouped && head.length <= 3) {
      integer = parts.join("");
    } else {
      integer = head;
      fraction = parts[1] ?? "";
    }
  }
  if (integer === "" && fraction === "") return null;
  const number = `${integer === "" ? "0" : integer}${fraction === "" ? "" : `.${fraction}`}`;
  return /^\d+(?:\.\d+)?$/u.test(number) ? number : null;
}

/** What amounts read in when no status has arrived to say. */
const DEFAULT_AMOUNT_DISPLAY: DisplayInfo = { unit: "usd", credit_usd: 0.01 };

/**
 * What the person typed in the amount field, in the display unit. Forgiving:
 * a leading or trailing currency sign or code ("$100", "100 USD", "€5"), or a
 * credit word ("100 credits", "5 AIU", "2 cr"), in any case; spaces; and the
 * locale's thousands separators ("1,000.50" in en, "1.000,50" in de). A unit
 * that isn't the display unit is converted at `credit_usd`, so the limit means
 * what was typed. Every currency counts as dollars: Maximal has no other rate.
 */
export function parseAmountDetailed(
  text: string,
  display: DisplayInfo = DEFAULT_AMOUNT_DISPLAY,
  locale = "en",
): AmountParse {
  let rest = text.trim();
  const units: Array<DisplayUnit> = [];
  const leading = LEADING_UNIT.exec(rest);
  if (leading) {
    units.push(unitOfToken(leading[0]));
    rest = rest.slice(leading[0].length);
  }
  const trailing = TRAILING_UNIT.exec(rest);
  if (trailing) {
    units.push(unitOfToken(trailing[0]));
    rest = rest.slice(0, rest.length - trailing[0].length);
  }
  // "$100 credits" names two units; there is no telling which one was meant.
  if (units.length === 2 && units[0] !== units[1]) return { ok: false, reason: "format" };
  const normalized = normalizeNumber(rest, locale);
  if (normalized === null) return { ok: false, reason: "format" };
  const typed = Number(normalized);
  if (!Number.isFinite(typed)) return { ok: false, reason: "format" };
  if (typed <= 0) return { ok: false, reason: "zero" };
  const unit = units[0] ?? display.unit;
  const rate = display.credit_usd > 0 ? display.credit_usd : DEFAULT_AMOUNT_DISPLAY.credit_usd;
  const value = unit === display.unit ? typed : unit === "credits" ? typed * rate : typed / rate;
  return Number.isFinite(value) && value > 0 ? { ok: true, value } : { ok: false, reason: "zero" };
}

/** The amount typed, in the display unit, or null when it isn't an amount above zero. */
export function parseAmount(text: string, display?: DisplayInfo, locale?: string): number | null {
  const parsed = parseAmountDetailed(text, display, locale);
  return parsed.ok ? parsed.value : null;
}

/** The dollar sign and which side of the number the locale writes it. */
export function currencyAffix(locale: string): { symbol: string; position: "prefix" | "suffix" } {
  try {
    const parts = new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).formatToParts(1);
    const at = parts.findIndex((part) => part.type === "currency");
    const integerAt = parts.findIndex((part) => part.type === "integer");
    if (at !== -1) return { symbol: parts[at]?.value ?? "$", position: at < integerAt ? "prefix" : "suffix" };
  } catch {
    /* an unknown locale reads like en */
  }
  return { symbol: "$", position: "prefix" };
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

export type LimitFormIssue = "amount" | "amount-zero" | "warn" | "target";

/**
 * The request for a form, or the first problem with it. The amount is sent in
 * the display unit (`amount`); the server converts and stores nano-AIU.
 */
export function buildPutRequest(
  form: LimitForm,
  display?: DisplayInfo,
  locale?: string,
): { ok: true; body: BudgetLimitPutRequest } | { ok: false; issue: LimitFormIssue } {
  const parsed = parseAmountDetailed(form.amount, display, locale);
  if (!parsed.ok) return { ok: false, issue: parsed.reason === "zero" ? "amount-zero" : "amount" };
  const amount = parsed.value;
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

/**
 * The amount field's starting text for an existing limit, in the display unit
 * and the locale's decimal mark (so it reads back the same), without grouping.
 */
export function amountText(value: number, locale = "en"): string {
  // Trim float noise (0.30000000000000004) without losing real digits.
  const trimmed = Number(value.toPrecision(10));
  try {
    return new Intl.NumberFormat(locale, { useGrouping: false, maximumFractionDigits: 10 }).format(trimmed);
  } catch {
    return String(trimmed);
  }
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

/** The most columns a chart will draw by filling the quiet hours and days in; beyond it the rows drawn are the rows there are. */
const MAX_FILLED_COLUMNS = 2400;

/** The key a bucket starts at: `2026-11-11T14:00:00Z` for an hour, `2026-11-11` for a day. */
function bucketKey(group: "day" | "hour", ms: number): string {
  const iso = new Date(ms).toISOString();
  return group === "day" ? iso.slice(0, 10) : `${iso.slice(0, 13)}:00:00Z`;
}

/**
 * The rows of a day or hour grouping with the quiet buckets filled in as zero,
 * so a chart's columns sit on an even time axis (the server leaves out a day or
 * hour that recorded nothing). The span is the range when it has a start
 * (`from` is epoch for "all", so that one runs from the first row), else the
 * first row to the last. A span too long to draw one column each is left as given.
 */
export function timeSeries(
  rows: ReadonlyArray<ActivityRow>,
  group: "day" | "hour",
  range?: { from: string; to: string; label: string },
): Array<ActivityRow> {
  const step = group === "day" ? DAY_MS : HOUR_MS;
  const floor = (ms: number): number => Math.floor(ms / step) * step;
  const first = rows.length > 0 ? Date.parse(rows[0]?.key ?? "") : Number.NaN;
  const last = rows.length > 0 ? Date.parse(rows[rows.length - 1]?.key ?? "") : Number.NaN;
  if (Number.isNaN(first) || Number.isNaN(last)) return [...rows];
  const rangeFrom = range && range.label !== "all" ? Date.parse(range.from) : Number.NaN;
  const rangeTo = range && range.label !== "all" ? Date.parse(range.to) : Number.NaN;
  const start = floor(Number.isNaN(rangeFrom) ? first : Math.min(rangeFrom, first));
  const end = floor(Number.isNaN(rangeTo) ? last : Math.max(rangeTo - 1, last));
  if ((end - start) / step + 1 > MAX_FILLED_COLUMNS) return [...rows];
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const filled: Array<ActivityRow> = [];
  for (let at = start; at <= end; at += step) {
    const key = bucketKey(group, at);
    filled.push(byKey.get(key) ?? { key, nano_aiu: 0, requests: 0, amount: 0 });
  }
  return filled;
}

/** The column height for a day, 0 to 1 of the tallest day. */
export function columnHeights(rows: ReadonlyArray<ActivityRow>): Array<number> {
  const max = rows.reduce((peak, row) => Math.max(peak, row.nano_aiu), 0);
  return rows.map((row) => (max > 0 ? row.nano_aiu / max : 0));
}

/** Groups that are a span of time (oldest first, drawn as columns) rather than a set of things. */
export function isTimeGroup(group: ActivityGroup): group is "day" | "hour" {
  return group === "day" || group === "hour";
}

/**
 * The query string the activity and CSV endpoints share, or null while a
 * custom range is incomplete. Groups that spent nothing are kept, so the
 * table agrees with the totals and with the Dashboard, which lists every model.
 */
export function activityQuery(choice: RangeChoice, group: ActivityGroup): string | null {
  const range = rangeParams(choice);
  if (!range) return null;
  return new URLSearchParams([...range, ["group", group], ["include_free", "true"]]).toString();
}

/** A file name for the exported statement, naming its range and grouping: `maximal-activity-7d-by-model.csv`. */
export function csvFileName(choice: RangeChoice, group: ActivityGroup): string {
  return `maximal-activity-${rangeFileLabel(choice)}-by-${group}.csv`;
}

/** A token or request count for a table cell: "1.2M", "345K", "812". The exact figure belongs in the cell's title. */
export function formatCompact(value: number, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(value);
  } catch {
    return String(value);
  }
}

/** The measures a table row or the totals strip shows, in the Dashboard's order. */
export interface UsageFigures {
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/** A row's measures; a row from a server that predates the token fields reads zero tokens. */
export function rowFigures(row: ActivityRow): UsageFigures {
  const input = row.input_tokens ?? 0;
  const output = row.output_tokens ?? 0;
  const cacheRead = row.cache_read_input_tokens ?? 0;
  const cacheWrite = row.cache_creation_input_tokens ?? 0;
  return {
    requests: row.requests,
    input,
    output,
    cacheRead,
    cacheWrite,
    total: row.total_tokens ?? input + output + cacheRead + cacheWrite,
  };
}

/**
 * The totals strip's measures: the response's `totals` (everything the range
 * recorded, free groups included, like the Dashboard's), else the sum of the
 * rows for a server that doesn't send them.
 */
export function activityTotals(
  activity: Pick<BudgetActivityResponse, "totals" | "rows">,
): UsageFigures & { nanoAiu: number } {
  const { totals } = activity;
  if (totals) {
    return {
      requests: totals.request_count,
      input: totals.input_tokens,
      output: totals.output_tokens,
      cacheRead: totals.cache_read_input_tokens,
      cacheWrite: totals.cache_creation_input_tokens,
      total: totals.total_tokens,
      nanoAiu: totals.total_nano_aiu,
    };
  }
  return activity.rows.reduce(
    (acc, row) => {
      const figures = rowFigures(row);
      return {
        requests: acc.requests + figures.requests,
        input: acc.input + figures.input,
        output: acc.output + figures.output,
        cacheRead: acc.cacheRead + figures.cacheRead,
        cacheWrite: acc.cacheWrite + figures.cacheWrite,
        total: acc.total + figures.total,
        nanoAiu: acc.nanoAiu + row.nano_aiu,
      };
    },
    { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, nanoAiu: 0 },
  );
}
