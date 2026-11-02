import type { SessionsResponse, SessionView } from "../../../../src/lib/token-usage/sessions-schema";
import type { FlowEdge, FlowNode, FlowPalette, FlowSnapshot } from "./flow-types";

const MAX_SESSION_NODES = 6;

type TokenRates = NonNullable<SessionView["rates"]>;
type ModelRates = NonNullable<SessionView["model_rates"]>[number];
type ModelTokenTotals = NonNullable<SessionView["model_token_totals"]>[number];

export interface FlowPlanLabels {
  clients: Record<SessionView["client"], string>;
  sessionId(id: string): string;
  otherSessions(count: number): string;
  otherLiveSessions: string;
  illustrativeToolActivity: string;
}

const DEFAULT_LABELS: FlowPlanLabels = {
  clients: {
    "claude-code": "Claude Code",
    "claude-desktop": "Claude Desktop",
    codex: "Codex",
    other: "Other app",
  },
  sessionId: (id) => `Session ${id}`,
  otherSessions: (count) => `${count} other sessions`,
  otherLiveSessions: "Other live sessions",
  illustrativeToolActivity: "Illustrative tool activity",
};

function modelName(model: string): string {
  return model
    .replace(/^claude-/u, "")
    .split("-")
    .map((part) => {
      if (part === "gpt") return "GPT";
      if (/^\d+$/u.test(part)) return part;
      return `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`;
    })
    .join(" ")
    .replace(/ (\d) (\d)$/u, " $1.$2")
    .replace(/^GPT /u, "GPT-");
}

const isLiveSession = (session: SessionView): boolean =>
  session.state !== "cold" && !session.id.startsWith("other:");

function fallbackRates(session: SessionView): TokenRates {
  const rate = Math.max(0, session.rate_per_min);
  const cacheRead = session.cache.last_cache_read_tokens > 0 ? rate * 0.16 : 0;
  const output = rate * 0.4;
  const input = rate - output - cacheRead;
  return {
    input_per_min: input,
    output_per_min: output,
    cache_read_per_min: cacheRead,
    cache_write_per_min: 0,
    total_per_min: rate,
  };
}

const ratesFor = (session: SessionView): TokenRates => session.rates ?? fallbackRates(session);

function modelRatesFor(session: SessionView): Array<ModelRates> {
  if (session.model_rates && session.model_rates.length > 0) return session.model_rates;
  return [{ model: session.model, ...ratesFor(session) }];
}

function modelTokenTotalsFor(session: SessionView): Map<string, ModelTokenTotals> {
  return new Map(
    (session.model_token_totals ?? []).map((totals) => [totals.model, totals]),
  );
}

function pickSessions(sessions: Array<SessionView>, selectedId: string | null): {
  shown: Array<SessionView>;
  hidden: Array<SessionView>;
} {
  const ranked = [...sessions].sort(
    (a, b) => b.rate_per_min - a.rate_per_min || b.last_request_at_ms - a.last_request_at_ms,
  );
  const shown = ranked.slice(0, MAX_SESSION_NODES);
  if (selectedId !== null && !shown.some((session) => session.id === selectedId)) {
    const selected = ranked.find((session) => session.id === selectedId);
    if (selected) shown[shown.length - 1] = selected;
  }
  const visible = new Set(shown.map((session) => session.id));
  return { shown, hidden: ranked.filter((session) => !visible.has(session.id)) };
}

function addEdges(
  edges: Array<FlowEdge>,
  sessionId: string,
  rates: ModelRates,
  totals?: ModelTokenTotals,
): void {
  const modelId = `model:${rates.model}`;
  const kinds = [
    ["input", sessionId, modelId, rates.input_per_min, totals?.input_tokens],
    ["output", modelId, sessionId, rates.output_per_min, totals?.output_tokens],
    ["cache-read", sessionId, modelId, rates.cache_read_per_min, totals?.cache_read_tokens],
    ["cache-write", sessionId, modelId, rates.cache_write_per_min, totals?.cache_write_tokens],
  ] as const;
  for (const [kind, from, to, rate, observedTokens] of kinds) {
    if (rate <= 0 && (observedTokens ?? 0) <= 0) continue;
    edges.push({
      id: `${sessionId}:${rates.model}:${kind}`,
      from,
      to,
      kind,
      rate,
      observedTokens,
    });
  }
}

function addRates(target: TokenRates, source: TokenRates): void {
  target.input_per_min += source.input_per_min;
  target.output_per_min += source.output_per_min;
  target.cache_read_per_min += source.cache_read_per_min;
  target.cache_write_per_min += source.cache_write_per_min;
  target.total_per_min += source.total_per_min;
}

const emptyRates = (): TokenRates => ({
  input_per_min: 0,
  output_per_min: 0,
  cache_read_per_min: 0,
  cache_write_per_min: 0,
  total_per_min: 0,
});

export interface FlowEmission {
  edgeId: string;
  count: number;
}

export interface ObservedFlowDeltas {
  observations: Map<string, number>;
  emissions: Array<FlowEmission>;
  tokensPerParticle: number | null;
}

/**
 * Compare cumulative edge counters from two polls. The first snapshot is only a
 * baseline; later positive deltas become a bounded, proportionally allocated
 * burst. Missing counters are an older sidecar and deliberately produce no
 * animation. A decrease resets that edge's baseline without replaying history.
 */
export function observeFlowDeltas(
  previous: ReadonlyMap<string, number> | null,
  edges: Array<FlowEdge>,
  maxParticles = 48,
): ObservedFlowDeltas {
  const observations = new Map<string, number>();
  const deltas: Array<{ edgeId: string; tokens: number }> = [];
  for (const edge of edges) {
    if (edge.observedTokens === undefined) continue;
    const observed = Math.max(0, Math.floor(edge.observedTokens));
    observations.set(edge.id, observed);
    if (previous === null) continue;
    const before = previous.get(edge.id);
    const delta = before === undefined ? observed : observed - before;
    if (delta > 0) deltas.push({ edgeId: edge.id, tokens: delta });
  }

  const total = deltas.reduce((sum, delta) => sum + delta.tokens, 0);
  const desired = Math.min(Math.max(0, maxParticles), total);
  if (desired <= 0) {
    return { observations, emissions: [], tokensPerParticle: null };
  }

  const allocations = deltas.map((delta) => {
    const exact = (desired * delta.tokens) / total;
    return {
      edgeId: delta.edgeId,
      count: Math.floor(exact),
      remainder: exact - Math.floor(exact),
    };
  });
  let unassigned = desired - allocations.reduce((sum, item) => sum + item.count, 0);
  for (const allocation of [...allocations].sort((a, b) => b.remainder - a.remainder)) {
    if (unassigned <= 0) break;
    allocation.count++;
    unassigned--;
  }

  return {
    observations,
    emissions: allocations
      .filter((allocation) => allocation.count > 0)
      .map(({ edgeId, count }) => ({ edgeId, count })),
    tokensPerParticle: total / desired,
  };
}

/**
 * Build the worker's producer/consumer graph from the server's exact 5-minute
 * rates and cumulative per-role counters. Older sidecars have neither split
 * field, so their topology stays visible but static. Tool endpoints remain
 * opt-in mock data until WebFetch/WebSearch activity is persisted by the proxy.
 */
export function liveFlowSnapshot(
  view: SessionsResponse,
  selectedSessionId: string | null,
  palette: FlowPalette,
  reducedMotion: boolean,
  includeSyntheticTools: boolean,
  labels: FlowPlanLabels = DEFAULT_LABELS,
): FlowSnapshot {
  const sessions = view.sessions.filter(isLiveSession);
  const totalRate = sessions.reduce((sum, session) => sum + ratesFor(session).total_per_min, 0);
  const { shown, hidden } = pickSessions(sessions, selectedSessionId);
  const modelTotals = new Map<string, TokenRates>();
  for (const session of sessions) {
    for (const rates of modelRatesFor(session)) {
      const total = modelTotals.get(rates.model) ?? emptyRates();
      addRates(total, rates);
      modelTotals.set(rates.model, total);
    }
  }
  const allModelRate = [...modelTotals.values()].reduce((sum, rates) => sum + rates.total_per_min, 0);
  const models: Array<FlowNode> = [...modelTotals]
    .sort(([, a], [, b]) => b.total_per_min - a.total_per_min)
    .map(([model, rates]) => ({
      id: `model:${model}`,
      label: modelName(model),
      detail: "",
      kind: "model",
      rate: rates.total_per_min,
      share: allModelRate > 0 ? rates.total_per_min / allModelRate : 0,
    }));

  const mockToolRate = includeSyntheticTools ? totalRate * 0.07 : 0;
  const endpointRate = totalRate + mockToolRate;
  const endpoints: Array<FlowNode> = shown.map((session) => {
    const rate = ratesFor(session).total_per_min;
    const client = labels.clients[session.client];
    return {
      id: `session:${session.id}`,
      label: session.client_label || client,
      detail: session.client_label ? `${client} · ${session.id.slice(0, 8)}` : labels.sessionId(session.id.slice(0, 8)),
      kind: "session",
      rate,
      share: endpointRate > 0 ? rate / endpointRate : 0,
    };
  });
  const edges: Array<FlowEdge> = [];
  for (const session of shown) {
    const sessionId = `session:${session.id}`;
    const totalsByModel = modelTokenTotalsFor(session);
    for (const rates of modelRatesFor(session)) {
      addEdges(edges, sessionId, rates, totalsByModel.get(rates.model));
    }
  }

  if (hidden.length > 0) {
    const otherId = "aggregate:sessions";
    const hiddenRate = hidden.reduce((sum, session) => sum + ratesFor(session).total_per_min, 0);
    endpoints.push({
      id: otherId,
      label: labels.otherSessions(hidden.length),
      detail: labels.otherLiveSessions,
      kind: "session",
      rate: hiddenRate,
      share: endpointRate > 0 ? hiddenRate / endpointRate : 0,
    });
    const hiddenModels = new Map<string, ModelRates>();
    const hiddenTotals = new Map<string, ModelTokenTotals>();
    const hasCompleteTotals = hidden.every(
      (session) => session.model_token_totals !== undefined,
    );
    for (const session of hidden) {
      for (const rates of modelRatesFor(session)) {
        const total = hiddenModels.get(rates.model) ?? { model: rates.model, ...emptyRates() };
        addRates(total, rates);
        hiddenModels.set(rates.model, total);
      }
      if (!hasCompleteTotals) continue;
      for (const observed of session.model_token_totals ?? []) {
        const total = hiddenTotals.get(observed.model) ?? {
          model: observed.model,
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          total_tokens: 0,
        };
        total.input_tokens += observed.input_tokens;
        total.output_tokens += observed.output_tokens;
        total.cache_read_tokens += observed.cache_read_tokens;
        total.cache_write_tokens += observed.cache_write_tokens;
        total.total_tokens += observed.total_tokens;
        hiddenTotals.set(observed.model, total);
      }
    }
    for (const rates of hiddenModels.values()) {
      addEdges(
        edges,
        otherId,
        rates,
        hasCompleteTotals ? hiddenTotals.get(rates.model) : undefined,
      );
    }
  }

  const tools: Array<FlowNode> = [];
  if (includeSyntheticTools && models.length > 0 && totalRate > 0) {
    const busiestModel = models[0].id;
    const toolSpecs = [
      { id: "tool:web-fetch", label: "Web fetch", share: 0.04 },
      { id: "tool:web-search", label: "Web search", share: 0.03 },
    ];
    for (const tool of toolSpecs) {
      const rate = totalRate * tool.share;
      tools.push({
        id: tool.id,
        label: tool.label,
        detail: labels.illustrativeToolActivity,
        kind: "tool",
        rate,
        share: rate / endpointRate,
      });
      edges.push(
        {
          id: `${tool.id}:request`,
          from: busiestModel,
          to: tool.id,
          kind: "output",
          rate: rate * 0.35,
        },
        {
          id: `${tool.id}:result`,
          from: tool.id,
          to: busiestModel,
          kind: "input",
          rate: rate * 0.65,
        },
      );
    }
  }

  const visibleSelected =
    selectedSessionId !== null
    && endpoints.some((endpoint) => endpoint.id === `session:${selectedSessionId}`) ?
      selectedSessionId
    : null;
  return {
    nodes: [...models, ...endpoints, ...tools],
    edges,
    totalRate,
    selectedSessionId: visibleSelected,
    reducedMotion,
    palette,
  };
}
