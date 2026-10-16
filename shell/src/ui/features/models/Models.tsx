import { Button } from "../../components/Button";
import { ProblemCallout } from "../../components/ProblemCallout";
import { EmptyState } from "../../components/EmptyState";
import type { ModelSummary } from "../../../../../src/lib/config/settings-types";

import { useModels } from "./useModels";

/** Human label for a `capabilities.type`. Falls back to a capitalized
 *  form for any type we don't have a friendlier name for. */
function groupLabel(type: string): string {
  if (type === "chat") return "Chat models";
  if (type === "embeddings") return "Embeddings";
  return type.charAt(0).toUpperCase() + type.slice(1);
}

/** Compact token count: 200000 → "200K", 1000000 → "1M", null → "—". */
function formatTokens(n: number | null): string {
  if (n === null) return "—";
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

/** Relative age of the cache, e.g. "just now", "3 min ago", "2 h ago".
 *  Null timestamp (never loaded) is handled by the caller. */
function formatAge(iso: string): string {
  const then = new Date(iso).getTime();
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} d ago`;
}

/** The capability flags a model has, as plain words ("Vision · Tools"). */
function capabilityText(capabilities: ModelSummary["capabilities"]): string {
  const flags: Array<[string, boolean]> = [
    ["Vision", capabilities.vision],
    ["Tools", capabilities.tool_calls],
    ["Streaming", capabilities.streaming],
    ["Reasoning", capabilities.reasoning],
  ];
  return flags
    .filter(([, on]) => on)
    .map(([label]) => label)
    .join(" · ");
}

/**
 * One model as a two-line row: who it is on the left (name, then the id a
 * client sends), what it can hold on the right (context, then max output),
 * capabilities underneath the name. Numbers carry their own labels, so the
 * list needs no column headers.
 */
function ModelRow({ model }: { model: ModelSummary }): JSX.Element {
  const capabilities = capabilityText(model.capabilities);
  return (
    <li className="model-row">
      <div className="model-row__who">
        <span className="model-row__name">
          {model.name}
          {model.preview && <span className="model-row__tag">Preview</span>}
        </span>
        <code className="model-row__id">{model.id}</code>
        {capabilities && <span className="model-row__caps">{capabilities}</span>}
      </div>
      <dl className="model-row__limits">
        <div>
          <dt>Context</dt>
          <dd>{formatTokens(model.context_window_tokens)}</dd>
        </div>
        <div>
          <dt>Max output</dt>
          <dd>{formatTokens(model.max_output_tokens)}</dd>
        </div>
      </dl>
    </li>
  );
}

function ModelGroup({
  type,
  models,
  open,
}: {
  type: string;
  models: Array<ModelSummary>;
  open: boolean;
}): JSX.Element {
  return (
    <details
      className="advanced-section"
      open={open}
    >
      <summary className="advanced-section__summary">
        <span className="advanced-section__title">
          {groupLabel(type)}{" "}
          <span className="models__count">{models.length}</span>
        </span>
      </summary>
      <ul className="advanced-section__body model-list">
        {models.map((model) => (
          <ModelRow key={model.id} model={model} />
        ))}
      </ul>
    </details>
  );
}

export function Models(): JSX.Element {
  const { models, loadedAt, isLoading, isRefreshing, problem, refresh } =
    useModels();

  // Preserve the server's type-then-name order while grouping.
  const groups: Array<[string, Array<ModelSummary>]> = [];
  for (const model of models) {
    const last = groups[groups.length - 1];
    if (last && last[0] === model.type) {
      last[1].push(model);
    } else {
      groups.push([model.type, [model]]);
    }
  }

  const showEmpty = !isLoading && models.length === 0;

  return (
    <div className="models">
      <div className="models__toolbar">
        <span className="models__freshness">
          {loadedAt !== null && `Updated ${formatAge(loadedAt)}`}
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

      {/* The toolbar's Refresh is the retry, so the banner only adds a
          button for remedies it doesn't cover (restart, sign in). */}
      {problem && (
        <ProblemCallout problem={problem} onRestarted={() => void refresh()} />
      )}

      {showEmpty && !problem ?
        <EmptyState title="No models cached" compact>
          <p>
            Sign in and the catalog loads automatically. If you're already
            signed in, use Refresh now to pull the current list from the
            provider.
          </p>
        </EmptyState>
      : groups.map(([type, list], index) => (
          <ModelGroup
            key={type}
            type={type}
            models={list}
            open={index === 0}
          />
        ))
      }
    </div>
  );
}
