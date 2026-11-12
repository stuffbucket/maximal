// The Dashboard's quota column (GitHub's /usage), for each state the
// refresher can be in (see usage-refresh.ts). Strings only, no DOM, so the
// root test suite can import it.
//
// A failed read is "not available yet", never a red error: the last good
// numbers stay, greyed, under a quiet line saying how old they are, and before
// the first good read the usual layout shows placeholders. Only signing in is
// something the person can act on, so only that state asks them to.
import { resolveLocale, t } from "../i18n";
import type { RemoteUsage, UsageSnapshot } from "./usage-refresh";

export interface QuotaDetails {
  entitlement: number;
  remaining: number;
  percent_remaining: number;
  unlimited: boolean;
}

export interface UsageData {
  quota_snapshots?: Record<string, QuotaDetails> | null;
  /** When the quotas next reset (GitHub sends a date, "2025-07-01", UTC).
   *  The end of the current period; GitHub doesn't send its start. */
  quota_reset_date?: string;
}

export interface QuotaRenderOptions {
  /** Whether "Chat and completions" is unfolded. */
  quotaMoreOpen: boolean;
  now: number;
}

/** The quota every Copilot plan reports, standing in before the first read
 *  so the layout doesn't jump when the numbers arrive. */
const PLACEHOLDER_QUOTA = "premium_interactions";

export function escapeHtml(value: unknown): string {
  // Use regex .replace (ES2020-safe) rather than .replaceAll — the shell
  // tsconfig targets ES2020.
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The quota column's HTML for `usage`; empty while nothing has been asked. */
export function renderRemoteUsage(
  usage: RemoteUsage<UsageData>,
  options: QuotaRenderOptions,
): string {
  switch (usage.status) {
    case "idle":
      return "";
    case "signed-out":
      return renderQuotaColumn(renderUsageSignedOut());
    case "ready":
      return renderUsageQuotas(usage.snapshot, options);
    case "unavailable": {
      if (usage.snapshot) {
        const line = t("dashboard-usage-reconnecting", {
          ago: formatAgo(options.now - usage.snapshot.fetchedAt),
        });
        return renderUsageQuotas(usage.snapshot, options, {
          line,
          reason: usage.reason,
        });
      }
      return renderUnavailableColumn(
        t("dashboard-usage-waiting"),
        usage.reason,
        renderQuotaCard(
          PLACEHOLDER_QUOTA,
          {
            entitlement: Number.NaN,
            remaining: Number.NaN,
            percent_remaining: Number.NaN,
            unlimited: false,
          },
          null,
          undefined,
          options.now,
        ),
      );
    }
  }
}

/** GitHub's quota_reset_date as a timestamp. A bare date is midnight UTC. */
export function parseResetDate(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(
    /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value,
  );
  return Number.isFinite(ms) ? ms : null;
}

/** "12 minutes ago" in the UI locale: whole minutes (at least one), then
 *  hours, then days. */
export function formatAgo(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const format = new Intl.RelativeTimeFormat(resolveLocale(), {
    numeric: "always",
  });
  if (minutes < 60) return format.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return format.format(-hours, "hour");
  return format.format(-Math.round(hours / 24), "day");
}

/** The dynamic quota content inside the bento's static heading and card. */
function renderQuotaColumn(body: string): string {
  return `<div class="dashboard-bento__body">${body}</div>`;
}

/** Quotas we can't vouch for right now: the same layout in neutral ink
 *  (`.usage-quotas--unavailable`), under one quiet line saying why. The raw
 *  failure is the line's hover text, for bug reports. */
function renderUnavailableColumn(
  line: string,
  reason: string | undefined,
  body: string,
): string {
  const title = reason ? ` title="${escapeHtml(reason)}"` : "";
  return `<div class="dashboard-bento__body usage-quotas--unavailable">
                <p class="usage-status"${title}>${escapeHtml(line)}</p>
                ${body}</div>`;
}

function renderUsageSignedOut(): string {
  return `
    <div class="usage-signed-out">
      <i data-lucide="settings" aria-hidden="true"></i>
      <div class="usage-signed-out__content">
        <strong>${escapeHtml(t("account-setup-required-title"))}</strong>
        <p>${escapeHtml(t("account-setup-required-body"))}</p>
        <button type="button" class="usage-signed-out__action" data-usage-action="open-account-settings">
          ${escapeHtml(t("account-setup-required-action"))}
        </button>
      </div>
    </div>`;
}

/**
 * The "Usage Quotas" column: the metered cards stacked, then the unlimited
 * ones folded away. With `unavailable`, the snapshot is out of date and
 * renders greyed under its status line.
 */
function renderUsageQuotas(
  snapshot: UsageSnapshot<UsageData>,
  options: QuotaRenderOptions,
  unavailable?: { line: string; reason?: string },
): string {
  const snapshots = snapshot.data.quota_snapshots;
  if (!snapshots) return "";

  const entries = Object.entries(snapshots);
  const metered = entries.filter(([, value]) => !value.unlimited);
  const unlimited = entries.filter(([, value]) => value.unlimited);
  const resetMs = parseResetDate(snapshot.data.quota_reset_date);
  const meteredCards = metered
    .map(([key, value]) =>
      renderQuotaCard(key, value, resetMs, snapshot.fetchedAt, options.now),
    )
    .join("");
  // Unlimited quotas have nothing to measure, so they share one list, folded
  // away under the metered cards. With no metered card it is all there is.
  const unlimitedHtml =
    unlimited.length > 0
      ? renderUnlimitedQuotas(
          unlimited.map(([key]) => key),
          options.quotaMoreOpen,
        )
      : "";

  if (!meteredCards && !unlimitedHtml) return "";
  const body = `
                ${meteredCards ? `<div class="flex flex-col gap-4">${meteredCards}</div>` : ""}
                ${unlimitedHtml}`;
  return unavailable
    ? renderUnavailableColumn(unavailable.line, unavailable.reason, body)
    : renderQuotaColumn(body);
}

/** "Jul 1" in the UI locale. Shown in UTC: GitHub's date is a UTC date, and
 *  local time would turn "Jul 1" into "Jun 30" west of Greenwich. */
function formatResetDate(ms: number): string {
  return new Intl.DateTimeFormat(resolveLocale(), {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(ms);
}

/**
 * Renders a single quota card: percent used as the headline, the meter, the
 * counts, and when the period resets. The meter's color says how close the
 * quota is to its limit (see .meter in style.css), with an icon from
 * "running low" on so the state never rests on color alone. Unlimited
 * quotas don't come here (renderUnlimitedQuotas): a full bar would read as
 * "used up".
 *
 * If the period these numbers belong to has already ended (the window sat
 * open across the reset), or GitHub's numbers don't add up (or there are no
 * numbers yet), the figures show "—" rather than a stale or made-up
 * percentage.
 */
function renderQuotaCard(
  title: string,
  details: QuotaDetails,
  resetMs: number | null,
  fetchedAt: number | undefined,
  now: number,
): string {
  const { entitlement, remaining, percent_remaining } = details;
  const ended = resetMs !== null && now >= resetMs;
  const known =
    !ended &&
    Number.isFinite(percent_remaining) &&
    Number.isFinite(entitlement) &&
    Number.isFinite(remaining) &&
    entitlement > 0;
  const percentUsed = known ? 100 - percent_remaining : 0;
  const level = !known
    ? "ok"
    : percentUsed >= 90
      ? "out"
      : percentUsed >= 75
        ? "low"
        : "ok";
  const icon =
    level === "ok"
      ? ""
      : `<i data-lucide="triangle-alert" aria-hidden="true"></i>`;

  const period =
    resetMs === null
      ? ""
      : ended
        ? t("dashboard-quota-period-ended", { date: formatResetDate(resetMs) })
        : t("dashboard-quota-resets", { date: formatResetDate(resetMs) });
  const asOf =
    fetchedAt === undefined
      ? ""
      : t("dashboard-quota-as-of", {
          time: new Intl.DateTimeFormat(resolveLocale(), {
            timeStyle: "short",
          }).format(fetchedAt),
        });

  return `
            <header class="usage-panel__header" title="${escapeHtml(asOf)}">
                <div class="usage-panel__heading">
                    <h3 class="usage-panel__title">${escapeHtml(title.replace(/_/g, " "))}</h3>
                    ${period ? `<p class="usage-panel__subtitle">${escapeHtml(period)}</p>` : ""}
                </div>
                <output class="usage-panel__headline meter-state meter-state--${level} meter-state--headline">${icon}${
                  known
                    ? escapeHtml(
                        t("dashboard-quota-percent-used", {
                          percent: percentUsed.toFixed(1),
                        }),
                      )
                    : "—"
                }</output>
            </header>
            <div class="usage-panel__body">
                ${
                  known
                    ? `<progress class="quota-progress quota-progress--${level}" max="100" value="${Math.min(100, Math.max(0, percentUsed))}" aria-label="${escapeHtml(title.replace(/_/g, " "))}"></progress>`
                    : `<div class="quota-progress quota-progress--unknown" aria-hidden="true"></div>`
                }
                <div class="usage-panel__meta">
                    <span>${known ? `${(entitlement - remaining).toLocaleString()} / ${entitlement.toLocaleString()}` : "—"}</span>
                    <span>${known ? escapeHtml(t("dashboard-quota-remaining", { n: remaining.toLocaleString() })) : ""}</span>
                </div>
            </div>
        `;
}

/**
 * The unlimited quotas, folded behind a chevron: name, then "Unlimited".
 * The open state lives in main.ts (`state.quotaMoreOpen`).
 */
function renderUnlimitedQuotas(titles: Array<string>, open: boolean): string {
  const rows = titles
    .map(
      (title) => `
                <div class="quota-more__row">
                    <h3 class="quota-more__title">${escapeHtml(title.replace(/_/g, " "))}</h3>
                    <span class="quota-more__value">${escapeHtml(t("dashboard-quota-unlimited"))}</span>
                </div>`,
    )
    .join("");
  return `
            <details class="quota-more" data-quota-more${open ? " open" : ""}>
                <summary class="quota-more__summary"><i data-lucide="chevron-right" class="quota-more__chevron" aria-hidden="true"></i>${escapeHtml(t("dashboard-quotas-more"))}</summary>
                <div class="quota-more__body">${rows}
                </div>
            </details>
        `;
}
