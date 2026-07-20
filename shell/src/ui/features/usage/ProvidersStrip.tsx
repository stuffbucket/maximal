import type { QuotaDetails, TokenUsageProviderSummary } from "./usage-types"

import { formatCostAiu, formatNumber, providerLabel, quotaView } from "./format"

/**
 * Connected-providers strip (§4). Cards ARE warranted here — each provider is a
 * discrete entity with its own identity, traffic, and (for Copilot) quota. Built
 * provider-forward: one card today (GitHub Copilot), N tomorrow. This is usage +
 * quota per provider; account identity/management stays in the `account` section.
 */

/** Copilot quota snapshots are the only live entitlements today; attach them to
 *  the matching provider card. Keyed by the provider display key. */
function QuotaMeter({
  name,
  details,
}: {
  name: string
  details: QuotaDetails
}): React.ReactElement {
  const view = quotaView(details)
  return (
    <div
      className={`usage-provider__quota usage-provider__quota--${view.level}`}
    >
      <div className="usage-provider__quota-head">
        <span className="usage-provider__quota-name">
          {name.split("_").join(" ")}
        </span>
        <span className="usage-provider__quota-pct">
          {view.level === "unlimited" ?
            "Unlimited"
          : `${view.percentUsed.toFixed(0)}%`}
        </span>
      </div>
      <div className="usage-provider__quota-bar">
        <span
          className="usage-provider__quota-fill"
          style={{
            width: `${view.level === "unlimited" ? 100 : view.percentUsed}%`,
          }}
        />
      </div>
    </div>
  )
}

function ProviderCard({
  summary,
  quotas,
}: {
  summary: TokenUsageProviderSummary
  quotas: Record<string, QuotaDetails> | null
}): React.ReactElement {
  const isCopilot = summary.provider === "copilot"
  const quotaEntries = isCopilot && quotas ? Object.entries(quotas) : []
  return (
    <article className="usage-provider">
      <header className="usage-provider__head">
        <span className="usage-provider__name">
          {providerLabel(summary.provider)}
        </span>
        <span className="usage-provider__source">{summary.source}</span>
      </header>
      <dl className="usage-provider__stats">
        <div className="usage-provider__stat">
          <dt>Tokens</dt>
          <dd>{formatNumber(summary.total_tokens)}</dd>
        </div>
        <div className="usage-provider__stat">
          <dt>Requests</dt>
          <dd>{formatNumber(summary.request_count)}</dd>
        </div>
        <div className="usage-provider__stat">
          <dt>Cost</dt>
          <dd>{formatCostAiu(summary.total_nano_aiu)}</dd>
        </div>
      </dl>
      {quotaEntries.length > 0 && (
        <div className="usage-provider__quotas">
          {quotaEntries.map(([name, details]) => (
            <QuotaMeter key={name} name={name} details={details} />
          ))}
        </div>
      )}
    </article>
  )
}

export function ProvidersStrip({
  providers,
  quotas,
}: {
  providers: ReadonlyArray<TokenUsageProviderSummary>
  quotas: Record<string, QuotaDetails> | null
}): React.ReactElement | null {
  // Nothing recorded yet but quotas exist → still show a Copilot card so the
  // entitlement is visible before any traffic.
  const rows: Array<TokenUsageProviderSummary> =
    providers.length > 0 ? [...providers] : []
  if (rows.length === 0 && quotas && Object.keys(quotas).length > 0) {
    rows.push({
      source: "copilot",
      provider_name: null,
      provider: "copilot",
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
      request_count: 0,
      total_tokens: 0,
      total_nano_aiu: 0,
    })
  }
  if (rows.length === 0) return null

  return (
    <div className="usage-providers" aria-label="Connected providers">
      {rows.map((p) => (
        <ProviderCard key={p.provider} summary={p} quotas={quotas} />
      ))}
    </div>
  )
}
