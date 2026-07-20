import type { ReactElement } from "react"

import type { RankedRow, Segment } from "./ProportionBar"
import type {
  TokenUsageModelSummary,
  TokenUsageProviderSummary,
  TokenUsageSeries,
  TokenUsageSummary,
} from "./usage-types"

import { AreaTrend, type TrendPoint } from "./charts/AreaTrend"
import { LiveTrafficStream } from "./charts/LiveTrafficStream"
import { EventsTable } from "./EventsTable"
import {
  formatCostAiu,
  formatNumber,
  providerLabel,
  vizSeriesColor,
} from "./format"
import { ProportionBar, RankedBars } from "./ProportionBar"
import { ProvidersStrip } from "./ProvidersStrip"
import { useUsage, type UsagePeriod } from "./useUsage"

/**
 * Usage view (§4) — reworked into a single narrative scroll: a person-first
 * summary line, the live-traffic hero (the mesmerizing centerpiece), connected
 * providers, a where-it-went breakdown (proportion + ranked bars over the
 * detail table), and the recent-requests ledger. Provider-forward throughout.
 * Cards are reserved for provider entities; every other section is typographic.
 */

const PERIODS: ReadonlyArray<{ id: UsagePeriod; label: string; noun: string }> =
  [
    { id: "day", label: "Today", noun: "today" },
    { id: "week", label: "This week", noun: "this week" },
    { id: "month", label: "This month", noun: "this month" },
    { id: "all", label: "All time", noun: "all time" },
  ]

function periodNoun(period: UsagePeriod): string {
  return PERIODS.find((p) => p.id === period)?.noun ?? "today"
}

/** The person-first headline sentence with the numbers emphasized. */
function SummaryLine({
  summary,
  period,
}: {
  summary: TokenUsageSummary
  period: UsagePeriod
}): ReactElement {
  const { totals, byModel, byProvider } = summary
  const providerCount = byProvider.length
  return (
    <p className="usage__summary">
      {periodNoun(period) === "all time" ?
        "All time, you’ve sent "
      : <>
          {periodNoun(period).charAt(0).toUpperCase()
            + periodNoun(period).slice(1)}
          , you’ve sent{" "}
        </>
      }
      <strong>{formatNumber(totals.total_tokens)}</strong> tokens across{" "}
      <strong>{formatNumber(totals.request_count)}</strong>{" "}
      {totals.request_count === 1 ? "request" : "requests"} to{" "}
      <strong>{byModel.length}</strong>{" "}
      {byModel.length === 1 ? "model" : "models"}
      {providerCount > 0 ?
        <>
          {" "}
          via <strong>{providerCount}</strong>{" "}
          {providerCount === 1 ? "provider" : "providers"}
        </>
      : null}
      {totals.total_nano_aiu > 0 ?
        <>
          {" "}
          · <strong>{formatCostAiu(totals.total_nano_aiu)}</strong>
        </>
      : null}
      .
    </p>
  )
}

/** Input / output / cache split as one proportion bar. */
function tokenSplit(summary: TokenUsageSummary): Array<Segment> {
  const { totals } = summary
  return [
    {
      key: "input",
      label: "Input",
      value: totals.input_tokens,
      color: "var(--viz-input)",
    },
    {
      key: "output",
      label: "Output",
      value: totals.output_tokens,
      color: "var(--viz-output)",
    },
    {
      key: "cache",
      label: "Cache",
      value:
        totals.cache_read_input_tokens + totals.cache_creation_input_tokens,
      color: "var(--viz-cache)",
    },
  ]
}

function modelRows(
  byModel: ReadonlyArray<TokenUsageModelSummary>,
): Array<RankedRow> {
  return byModel.map((m, i) => ({
    key: m.model,
    label: m.model,
    value: m.total_tokens,
    color: vizSeriesColor(i),
    meta: `${formatNumber(m.request_count)} req`,
    badge: m.is_premium === true ? "premium" : undefined,
  }))
}

function providerRows(
  byProvider: ReadonlyArray<TokenUsageProviderSummary>,
): Array<RankedRow> {
  return byProvider.map((p, i) => ({
    key: p.provider,
    label: providerLabel(p.provider),
    value: p.total_tokens,
    color: vizSeriesColor(i),
    meta: `${formatNumber(p.request_count)} req`,
  }))
}

function seriesToTrend(series: TokenUsageSeries | null): Array<TrendPoint> {
  if (!series || !Array.isArray(series.buckets)) return []
  return series.buckets.map((b) => ({
    t: b.bucket_start_ms,
    input: b.input_tokens,
    output: b.output_tokens,
    cache: b.cache_read_input_tokens + b.cache_creation_input_tokens,
  }))
}

/** Detail table (depth layer) — the exhaustive per-model numbers. */
function ModelTable({
  byModel,
}: {
  byModel: ReadonlyArray<TokenUsageModelSummary>
}): ReactElement | null {
  if (byModel.length === 0) return null
  return (
    <details className="usage__detail">
      <summary className="usage__detail-summary">Per-model detail</summary>
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
          {byModel.map((row) => (
            <tr key={row.model}>
              <td>{row.model}</td>
              <td>{formatNumber(row.total_tokens)}</td>
              <td>{formatNumber(row.input_tokens)}</td>
              <td>{formatNumber(row.output_tokens)}</td>
              <td>{formatNumber(row.request_count)}</td>
              <td>{formatCostAiu(row.total_nano_aiu)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  )
}

/** The "where it went" analysis block — trend + split + ranked breakdowns. */
function WhereItWent({
  summary,
  series,
  period,
  trendLabel,
}: {
  summary: TokenUsageSummary
  series: TokenUsageSeries | null
  period: UsagePeriod
  trendLabel: string
}): ReactElement {
  return (
    <section className="usage__section" aria-label="Where it went">
      <h3 className="usage__section-title">Where it went — {trendLabel}</h3>
      <div className="usage__trend">
        <AreaTrend
          data={seriesToTrend(series)}
          height={120}
          ariaLabel={`Token traffic ${periodNoun(period)}`}
        />
      </div>
      <ProportionBar
        segments={tokenSplit(summary)}
        ariaLabel="Input, output and cache token split"
      />
      <div className="usage__breakdowns">
        {summary.byProvider.length > 1 && (
          <div className="usage__breakdown">
            <h4 className="usage__breakdown-title">By provider</h4>
            <RankedBars
              rows={providerRows(summary.byProvider)}
              ariaLabel="Tokens by provider"
            />
          </div>
        )}
        <div className="usage__breakdown">
          <h4 className="usage__breakdown-title">By model</h4>
          <RankedBars
            rows={modelRows(summary.byModel)}
            ariaLabel="Tokens by model"
          />
        </div>
      </div>
      <ModelTable byModel={summary.byModel} />
    </section>
  )
}

export function Usage(): ReactElement {
  const {
    summary,
    quotas,
    series,
    events,
    live,
    period,
    setPeriod,
    page,
    setPage,
    isLoading,
    error,
  } = useUsage()

  const trendLabel =
    PERIODS.find((p) => p.id === period)?.label ?? "This period"

  let content: ReactElement
  if (isLoading && summary === null) {
    content = <p className="usage__loading">Loading usage…</p>
  } else if (summary === null) {
    content = <p className="usage__empty">No usage data.</p>
  } else {
    const hasTraffic = summary.totals.request_count > 0
    content = (
      <>
        <SummaryLine summary={summary} period={period} />

        <LiveTrafficStream
          live={live}
          totalTokensToday={summary.totals.total_tokens}
          requestsToday={summary.totals.request_count}
        />

        <ProvidersStrip providers={summary.byProvider} quotas={quotas} />

        {hasTraffic ?
          <WhereItWent
            summary={summary}
            series={series}
            period={period}
            trendLabel={trendLabel}
          />
        : <p className="usage__empty">
            No requests recorded {periodNoun(period)} yet — traffic will appear
            here the moment it flows through.
          </p>
        }

        <EventsTable events={events} page={page} setPage={setPage} />
      </>
    )
  }

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
              p.id === period ?
                "usage__period usage__period--active"
              : "usage__period"
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

      {content}
    </div>
  )
}
