import type { SessionsResponse, SessionView } from "../../../../src/lib/token-usage/sessions-schema";
import type { FlowEdge, FlowNode, FlowPalette, FlowSnapshot } from "./flow-types";

const MAX_SESSION_NODES = 6;

type TokenRates = NonNullable<SessionView["rates"]>;
type ModelRates = NonNullable<SessionView["model_rates"]>[number];

const clientName = (client: SessionView["client"]): string => {
  if (client === "claude-code") return "Claude Code";
  if (client === "claude-desktop") return "Claude Desktop";
  if (client === "codex") return "Codex";
  return "Other app";
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
  session.state !== "cold" && !session.id.startsWith("other:") && session.rate_per_min > 0;

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

function addEdges(edges: Array<FlowEdge>, sessionId: string, rates: ModelRates): void {
  const modelId = `model:${rates.model}`;
  const kinds = [
    ["input", sessionId, modelId, rates.input_per_min],
    ["output", modelId, sessionId, rates.output_per_min],
    ["cache-read", sessionId, modelId, rates.cache_read_per_min],
    ["cache-write", sessionId, modelId, rates.cache_write_per_min],
  ] as const;
  for (const [kind, from, to, rate] of kinds) {
    if (rate <= 0) continue;
    edges.push({ id: `${sessionId}:${rates.model}:${kind}`, from, to, kind, rate });
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

/**
 * Build the worker's producer/consumer graph from the server's exact 5-minute
 * per-session and per-model rates. Older sidecars have no split fields, so the
 * fallback is deliberately isolated here. Tool endpoints remain opt-in mock
 * data until WebFetch/WebSearch activity is persisted by the proxy.
 */
export function liveFlowSnapshot(
  view: SessionsResponse,
  selectedSessionId: string | null,
  palette: FlowPalette,
  reducedMotion: boolean,
  includeSyntheticTools: boolean,
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
    const client = clientName(session.client);
    return {
      id: `session:${session.id}`,
      label: session.client_label || client,
      detail: session.client_label ? `${client} · ${session.id.slice(0, 4)}` : `Session ${session.id.slice(0, 4)}`,
      kind: "session",
      rate,
      share: endpointRate > 0 ? rate / endpointRate : 0,
    };
  });
  const edges: Array<FlowEdge> = [];
  for (const session of shown) {
    const sessionId = `session:${session.id}`;
    for (const rates of modelRatesFor(session)) addEdges(edges, sessionId, rates);
  }

  if (hidden.length > 0) {
    const otherId = "session:other";
    const hiddenRate = hidden.reduce((sum, session) => sum + ratesFor(session).total_per_min, 0);
    endpoints.push({
      id: otherId,
      label: `${hidden.length} other sessions`,
      detail: "Other live sessions",
      kind: "session",
      rate: hiddenRate,
      share: endpointRate > 0 ? hiddenRate / endpointRate : 0,
    });
    const hiddenModels = new Map<string, ModelRates>();
    for (const session of hidden) {
      for (const rates of modelRatesFor(session)) {
        const total = hiddenModels.get(rates.model) ?? { model: rates.model, ...emptyRates() };
        addRates(total, rates);
        hiddenModels.set(rates.model, total);
      }
    }
    for (const rates of hiddenModels.values()) addEdges(edges, otherId, rates);
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
        detail: "Illustrative tool activity",
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

  return {
    nodes: [...models, ...endpoints, ...tools],
    edges,
    totalRate,
    selectedSessionId,
    reducedMotion,
    palette,
  };
}
