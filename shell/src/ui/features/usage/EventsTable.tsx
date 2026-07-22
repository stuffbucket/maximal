import type { TokenUsageEventsPage } from "./usage-types"

import {
  endpointLabel,
  formatCellText,
  formatNumber,
  formatRelativeTime,
  providerLabel,
} from "./format"

/**
 * Recent-requests ledger (§4) — the depth layer beneath the live stream. Adds a
 * Provider column (the new dimension) and a human relative time. Server-side
 * paginated. Not a card: a titled table section.
 */
export function EventsTable({
  events,
  page,
  setPage,
}: {
  events: TokenUsageEventsPage | null
  page: number
  setPage: (p: number) => void
}): React.ReactElement | null {
  if (!events || !Array.isArray(events.items) || events.items.length === 0) {
    return null
  }
  const totalPages = Math.max(events.total_pages, 1)
  return (
    <section className="usage__events" aria-label="Recent requests">
      <h3 className="usage__events-title">Recent requests</h3>
      <table className="usage__table">
        <thead>
          <tr>
            <th>When</th>
            <th>Provider</th>
            <th>Model</th>
            <th>Endpoint</th>
            <th>Input</th>
            <th>Output</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          {events.items.map((event, index) => (
            <tr key={`${event.created_at_ms}-${index}`}>
              <td title={new Date(event.created_at_ms).toLocaleString()}>
                {formatRelativeTime(event.created_at_ms)}
              </td>
              <td>{providerLabel(event.provider_name ?? event.source)}</td>
              <td>{formatCellText(event.model)}</td>
              <td>{endpointLabel(event.endpoint)}</td>
              <td>{formatNumber(event.input_tokens)}</td>
              <td>{formatNumber(event.output_tokens)}</td>
              <td>{formatNumber(event.total_tokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="usage__pager">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => setPage(page - 1)}
        >
          Previous
        </button>
        <span>
          Page {events.page} of {totalPages}
        </span>
        <button
          type="button"
          disabled={page >= totalPages}
          onClick={() => setPage(page + 1)}
        >
          Next
        </button>
      </div>
    </section>
  )
}
