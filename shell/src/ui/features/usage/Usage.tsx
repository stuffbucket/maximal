import {
  formatCellText,
  formatCostAiu,
  formatNumber,
  quotaView,
} from "./format";
import type {
  QuotaDetails,
  TokenUsageModelSummary,
  TokenUsageSummary,
} from "./usage-types";
import { useUsage, type UsagePeriod } from "./useUsage";

/**
 * Usage section (spec §4) — the standalone dashboard ported onto the settings
 * SPA's design tokens. Headline totals + per-model breakdown over `/token-usage`.
 * Pure presentation over the hook; formatters are unit-tested in `format.ts`. The
 * old dashboard's paginated events table is a follow-on.
 */

const PERIODS: ReadonlyArray<{ id: UsagePeriod; label: string }> = [
  { id: "day", label: "Today" },
  { id: "week", label: "This week" },
  { id: "month", label: "This month" },
  { id: "all", label: "All time" },
];

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="usage__tile">
      <div className="usage__tile-value">{value}</div>
      <div className="usage__tile-label">{label}</div>
    </div>
  );
}

/** A single entitlement/quota card with a severity-coloured progress bar (§4). */
function QuotaCard({ name, details }: { name: string; details: QuotaDetails }) {
  const view = quotaView(details);
  return (
    <div className={`usage__quota usage__quota--${view.level}`}>
      <div className="usage__quota-head">
        <span className="usage__quota-name">{name.split("_").join(" ")}</span>
        <span className="usage__quota-pct">
          {view.level === "unlimited" ?
            "Unlimited"
          : `${view.percentUsed.toFixed(1)}% used`}
        </span>
      </div>
      <div className="usage__quota-bar">
        <div
          className="usage__quota-bar-fill"
          style={{ width: `${view.level === "unlimited" ? 100 : view.percentUsed}%` }}
        />
      </div>
      <div className="usage__quota-foot">
        <span>
          {view.used} / {view.entitlement}
        </span>
        <span>{view.remaining} left</span>
      </div>
    </div>
  );
}

function Quotas({
  quotas,
}: {
  quotas: Record<string, QuotaDetails> | null;
}) {
  const entries = quotas ? Object.entries(quotas) : [];
  if (entries.length === 0) return null;
  return (
    <section className="usage__quotas" aria-label="Quotas">
      {entries.map(([name, details]) => (
        <QuotaCard key={name} name={name} details={details} />
      ))}
    </section>
  );
}

function ModelRow({ row }: { row: TokenUsageModelSummary }) {
  return (
    <tr>
      <td>{formatCellText(row.model)}</td>
      <td>{formatNumber(row.total_tokens)}</td>
      <td>{formatNumber(row.input_tokens)}</td>
      <td>{formatNumber(row.output_tokens)}</td>
      <td>{formatNumber(row.request_count)}</td>
      <td>{formatCostAiu(row.total_nano_aiu)}</td>
    </tr>
  );
}

function Breakdown({ summary }: { summary: TokenUsageSummary }) {
  if (summary.byModel.length === 0) {
    return <p className="usage__empty">No usage recorded for this period yet.</p>;
  }
  return (
    <table className="usage__table">
      <thead>
        <tr>
          <th>Model</th>
          <th>Tokens</th>
          <th>Input</th>
          <th>Output</th>
          <th>Requests</th>
          <th>Cost</th>
        </tr>
      </thead>
      <tbody>
        {summary.byModel.map((row) => (
          <ModelRow key={row.model} row={row} />
        ))}
      </tbody>
    </table>
  );
}

export function Usage() {
  const { summary, quotas, period, setPeriod, isLoading, error } = useUsage();

  return (
    <div className="usage">
      <div className="usage__periods" role="tablist" aria-label="Usage period">
        {PERIODS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={p.id === period}
            className={
              p.id === period ? "usage__period usage__period--active" : "usage__period"
            }
            onClick={() => setPeriod(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>

      {error !== null && (
        <p className="usage__error" role="alert">
          Couldn’t load usage: {error}
        </p>
      )}

      {isLoading && summary === null ?
        <p className="usage__loading">Loading usage…</p>
      : summary === null ?
        <p className="usage__empty">No usage data.</p>
      : <>
          <Quotas quotas={quotas} />
          <div className="usage__tiles">
            <StatTile
              label="Total tokens"
              value={formatNumber(summary.totals.total_tokens)}
            />
            <StatTile
              label="Requests"
              value={formatNumber(summary.totals.request_count)}
            />
            <StatTile
              label="Cost"
              value={formatCostAiu(summary.totals.total_nano_aiu)}
            />
          </div>
          <Breakdown summary={summary} />
        </>
      }
    </div>
  );
}
