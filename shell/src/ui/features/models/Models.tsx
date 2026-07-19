import type { ReactElement } from "react"

import type { ModelSummary } from "../../../../../src/lib/config/settings-types"

import { Button } from "../../components/Button"
import { useModels } from "./useModels"

/** Human label for a `capabilities.type`. Falls back to a capitalized
 *  form for any type we don't have a friendlier name for. */
function groupLabel(type: string): string {
  if (type === "chat") return "Chat models"
  if (type === "embeddings") return "Embeddings"
  return type.charAt(0).toUpperCase() + type.slice(1)
}

/** Compact token count: 200000 → "200K", 1000000 → "1M", null → "—". */
function formatTokens(n: number | null): string {
  if (n === null) return "—"
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}

/** Relative age of the cache, e.g. "just now", "3 min ago", "2 h ago".
 *  Null timestamp (never loaded) is handled by the caller. */
function formatAge(iso: string): string {
  const then = new Date(iso).getTime()
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (seconds < 45) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  return `${days} d ago`
}

/** The present capability flags as labelled chips. */
function CapabilityChips({
  capabilities,
}: {
  capabilities: ModelSummary["capabilities"]
}): ReactElement {
  const flags: Array<[string, boolean]> = [
    ["Vision", capabilities.vision],
    ["Tools", capabilities.tool_calls],
    ["Streaming", capabilities.streaming],
    ["Reasoning", capabilities.reasoning],
  ]
  const present = flags.filter(([, on]) => on)
  if (present.length === 0) return <span className="models__muted">—</span>
  return (
    <span className="models__chips">
      {present.map(([label]) => (
        <span key={label} className="chip">
          {label}
        </span>
      ))}
    </span>
  )
}

function ModelGroup({
  type,
  models,
  open,
}: {
  type: string
  models: Array<ModelSummary>
  open: boolean
}): ReactElement {
  return (
    <details className="advanced-section" open={open}>
      <summary className="advanced-section__summary">
        <span className="advanced-section__title">
          {groupLabel(type)}{" "}
          <span className="models__count">({models.length})</span>
        </span>
      </summary>
      <div className="advanced-section__body">
        <table className="table models__table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Context</th>
              <th>Max out</th>
              <th>Capabilities</th>
            </tr>
          </thead>
          <tbody>
            {models.map((model) => (
              <tr key={model.id}>
                <td>
                  <span className="models__name">
                    {model.name}
                    {model.preview && (
                      <span className="models__preview">Preview</span>
                    )}
                  </span>
                  <span className="models__id">{model.id}</span>
                </td>
                <td>{formatTokens(model.context_window_tokens)}</td>
                <td>{formatTokens(model.max_output_tokens)}</td>
                <td>
                  <CapabilityChips capabilities={model.capabilities} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}

export function Models(): ReactElement {
  const { models, loadedAt, isLoading, isRefreshing, error, refresh } =
    useModels()

  // Preserve the server's type-then-name order while grouping.
  const groups: Array<[string, Array<ModelSummary>]> = []
  for (const model of models) {
    const last = groups.at(-1)
    if (last && last[0] === model.type) {
      last[1].push(model)
    } else {
      groups.push([model.type, [model]])
    }
  }

  const showEmpty = !isLoading && models.length === 0

  return (
    <div className="models">
      <div className="models__toolbar">
        <span className="models__freshness">
          {loadedAt === null ?
            "Not loaded yet"
          : `Updated ${formatAge(loadedAt)}`}
        </span>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void refresh()}
          disabled={isRefreshing}
        >
          {isRefreshing ? "Refreshing…" : "Refresh now"}
        </Button>
      </div>

      {error && (
        <p className="state__caption state__caption--error" role="alert">
          {error}
        </p>
      )}

      {showEmpty ?
        <div className="empty empty--compact">
          <p className="empty__title">No models cached</p>
          <p className="empty__body">
            Sign in and the catalog loads automatically. If you're already
            signed in, use Refresh now to pull the current list from the
            provider.
          </p>
        </div>
      : groups.map(([type, list], index) => (
          <ModelGroup key={type} type={type} models={list} open={index === 0} />
        ))
      }
    </div>
  )
}
