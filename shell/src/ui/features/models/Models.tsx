import type { ReactElement } from "react"

import type { ModelSummary } from "../../../../../src/lib/config/settings-types"

import { Alert } from "../../components/Alert"
import { Button } from "../../components/Button"
import { Disclosure } from "../../components/Disclosure"
import { Table, Tbody, Td, Th, Thead, Tr } from "../../components/Table"
import { formatRelativeAge, formatTokensCompact } from "../../format"
import { useModels } from "./useModels"

/** Human label for a `capabilities.type`. Falls back to a capitalized
 *  form for any type we don't have a friendlier name for. */
function groupLabel(type: string): string {
  if (type === "chat") return "Chat models"
  if (type === "embeddings") return "Embeddings"
  return type.charAt(0).toUpperCase() + type.slice(1)
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
    <Disclosure
      open={open}
      summary={
        <span className="advanced-section__title">
          {groupLabel(type)}{" "}
          <span className="models__count">({models.length})</span>
        </span>
      }
    >
      <Table className="models__table">
        <Thead>
          <Tr>
            <Th>Model</Th>
            <Th>Context</Th>
            <Th>Max out</Th>
            <Th>Capabilities</Th>
          </Tr>
        </Thead>
        <Tbody>
          {models.map((model) => (
            <Tr key={model.id}>
              <Td>
                <span className="models__name">
                  {model.name}
                  {model.preview && (
                    <span className="models__preview">Preview</span>
                  )}
                </span>
                <span className="models__id">{model.id}</span>
              </Td>
              <Td>{formatTokensCompact(model.context_window_tokens)}</Td>
              <Td>{formatTokensCompact(model.max_output_tokens)}</Td>
              <Td>
                <CapabilityChips capabilities={model.capabilities} />
              </Td>
            </Tr>
          ))}
        </Tbody>
      </Table>
    </Disclosure>
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
          : `Updated ${formatRelativeAge(loadedAt)}`}
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

      {error && <Alert>{error}</Alert>}

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
