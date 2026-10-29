// The Dashboard's live flow: compact throughput metrics in the quota column
// and an off-main-thread particle view of traffic between models and sessions.
//
// main.ts re-renders the quota content from strings, but #live-metrics and the
// graph host survive those renders. The worker owns every animation frame and
// all canvas drawing; the webview thread only sends snapshots and resizes.
import type { SessionsResponse } from "../../../../src/lib/token-usage/sessions-schema";
import { resolveLocale, t } from "../../i18n";
import type { FlowPlanLabels } from "./flow-plan";

import { liveFlowSnapshot } from "./flow-plan";
import type { FlowKind, FlowPalette, FlowWorkerMessage } from "./flow-types";

export interface LiveCard {
  update(view: SessionsResponse, selected: string | null): void;
  /** Say the sessions couldn't be read (`null` clears it). What's drawn stays. */
  showError(message: string | null): void;
  destroy(): void;
}

function html<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, i18nKey?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = className;
  if (i18nKey) {
    el.dataset.i18n = i18nKey;
    el.textContent = t(i18nKey);
  }
  return el;
}

const reducedMotion = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const CLIENT_CASE = {
  "claude-code": "code",
  "claude-desktop": "desktop",
  codex: "codex",
  other: "other",
} as const;

function usageRow(i18nKey: string): { row: HTMLDivElement; value: HTMLElement } {
  const row = html("div", "usage-row");
  const name = html("dt", "usage-row__label", i18nKey);
  const value = html("dd", "usage-row__value");
  row.append(name, value);
  return { row, value };
}

export function mountLiveCard(root: HTMLElement, metricsRoot: HTMLElement, cacheHitRoot: HTMLElement): LiveCard {
  const graphSection = root.closest<HTMLElement>(".dashboard-bento__live");
  root.classList.add("live");
  root.classList.remove("live--border");
  root.replaceChildren();
  metricsRoot.replaceChildren();
  cacheHitRoot.classList.add("usage-feature");
  cacheHitRoot.replaceChildren();

  const metricsHeader = html("header", "usage-panel__header");
  const metricsHeading = html("div", "usage-panel__heading");
  const metricsTitle = html("h3", "usage-panel__title", "dashboard-flow-token-use");
  const metricsSubtitle = html("p", "usage-panel__subtitle", "dashboard-flow-five-minute-average");
  metricsHeading.append(metricsTitle, metricsSubtitle);
  const primaryValue = html("output", "usage-panel__headline");
  primaryValue.textContent = "0";
  metricsHeader.append(metricsHeading, primaryValue);
  const inputRate = usageRow("dashboard-col-input");
  const outputRate = usageRow("dashboard-col-output");
  const cacheReadRate = usageRow("dashboard-col-cache-read");
  const cacheWriteRate = usageRow("dashboard-col-cache-write");
  const metricRows = html("dl", "usage-panel__rows");
  metricRows.append(inputRate.row, outputRate.row, cacheReadRate.row, cacheWriteRate.row);
  metricsRoot.append(metricsHeader, metricRows);

  const cacheHitCopy = html("div", "usage-feature__copy");
  const cacheHitLabel = html("span", "usage-feature__label", "dashboard-flow-cache-hit-rate");
  const cacheHitDetail = html("span", "usage-feature__detail", "dashboard-flow-cache-hit-detail");
  cacheHitCopy.append(cacheHitLabel, cacheHitDetail);
  const cacheHitValue = html("output", "usage-feature__value");
  cacheHitValue.textContent = "—";
  cacheHitRoot.append(cacheHitCopy, cacheHitValue);

  const inner = html("div", "live__inner");
  const error = html("p", "live__error");
  error.setAttribute("role", "alert");
  error.hidden = true;
  const errorTitle = html("span", "live__error-title");
  const errorMessage = html("span", "live__error-message");
  error.append(errorTitle, errorMessage);

  const plot = html("div", "live__plot live__plot--flow");
  const canvas = html("canvas", "live__flow-canvas");
  canvas.setAttribute("role", "img");
  const fallback = html("p", "live__flow-fallback");
  fallback.textContent = t("dashboard-error-generic");
  fallback.hidden = true;
  const flowSummary = html("p", "live__flow-summary");
  plot.append(canvas, fallback, flowSummary);
  inner.append(error, plot);
  root.append(inner);

  let worker: Worker | null = null;
  let size = { width: 0, height: 0 };
  let latestView: SessionsResponse | null = null;
  let latestSelected: string | null = null;
  let numbers = new Intl.NumberFormat(resolveLocale());
  let compactNumbers = new Intl.NumberFormat(resolveLocale(), {
    notation: "compact",
    maximumFractionDigits: 1,
  });

  const palette = (): FlowPalette => {
    const styles = getComputedStyle(root);
    const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const color = (name: string, fallbackColor: string): string => styles.getPropertyValue(name).trim() || fallbackColor;
    const fontSize = (name: string, fallbackSize: number): number => {
      const value = styles.getPropertyValue(name).trim();
      if (value.endsWith("rem")) return Number.parseFloat(value) * rootFontSize;
      if (value.endsWith("px")) return Number.parseFloat(value);
      return fallbackSize;
    };
    return {
      surface: color("--surface-card", "Canvas"),
      text: color("--text-strong", "CanvasText"),
      muted: color("--text-muted", "GrayText"),
      border: color("--border-strong", "GrayText"),
      input: color("--series-1", color("--accent", "Highlight")),
      output: color("--series-3", color("--link", "LinkText")),
      cacheRead: color("--series-4", color("--border-strong", "GrayText")),
      cacheWrite: color("--series-5", color("--border-strong", "GrayText")),
      fontFamily: color("--font-body", "sans-serif"),
      labelFontSize: fontSize("--text-sm", 14),
      detailFontSize: fontSize("--text-xs", 12),
      labelFontWeight: color("--weight-md", "500"),
      particleScaleTemplate: t("dashboard-flow-particle-scale", { rate: "__RATE__" }),
    };
  };

  const includeSyntheticTools = new URLSearchParams(location.search).has("flow-tools");

  function sendSnapshot(): void {
    if (!worker || !latestView) return;
    const labels: FlowPlanLabels = {
      clients: {
        "claude-code": t("dashboard-sessions-client", { client: CLIENT_CASE["claude-code"] }),
        "claude-desktop": t("dashboard-sessions-client", { client: CLIENT_CASE["claude-desktop"] }),
        codex: t("dashboard-sessions-client", { client: CLIENT_CASE.codex }),
        other: t("dashboard-sessions-client", { client: CLIENT_CASE.other }),
      },
      sessionId: (id) => t("dashboard-flow-session-id", { id }),
      otherSessions: (count) => t("dashboard-flow-other-sessions", { count }),
      otherLiveSessions: t("dashboard-flow-other-live-sessions"),
      illustrativeToolActivity: t("dashboard-flow-illustrative-tool"),
    };
    const snapshot = liveFlowSnapshot(
      latestView,
      latestSelected,
      palette(),
      reducedMotion(),
      includeSyntheticTools,
      labels,
    );
    worker.postMessage({ type: "snapshot", snapshot } satisfies FlowWorkerMessage);
    const nodeLabels = new Map(snapshot.nodes.map((node) => [node.id, node.label]));
    const kindLabels: Record<FlowKind, string> = {
      input: t("dashboard-col-input"),
      output: t("dashboard-col-output"),
      "cache-read": t("dashboard-col-cache-read"),
      "cache-write": t("dashboard-col-cache-write"),
    };
    const nodes = snapshot.nodes.map((node) => `${node.label}: ${Math.round(node.share * 100)}%`).join("; ");
    const edges = snapshot.edges
      .filter((edge) => edge.rate > 0)
      .map(
        (edge) =>
          `${kindLabels[edge.kind]}: ${nodeLabels.get(edge.from) ?? edge.from} → ${nodeLabels.get(edge.to) ?? edge.to}, ${numbers.format(Math.round(edge.rate))} ${t("dashboard-live-unit")}`,
      )
      .join("; ");
    flowSummary.textContent = `${nodes}. ${edges}`;
  }

  try {
    const offscreen = canvas.transferControlToOffscreen();
    worker = new Worker(new URL("./flow-worker.js", location.href), {
      type: "module",
      name: "maximal-live-flow",
    });
    worker.onmessage = (event: MessageEvent<{ type?: string }>) => {
      if (event.data.type === "ready") {
        canvas.dataset.renderer = "worker";
        sendSnapshot();
      }
    };
    worker.onerror = () => {
      fallback.hidden = false;
      canvas.hidden = true;
    };
    worker.postMessage(
      {
        type: "init",
        canvas: offscreen,
        width: size.width,
        height: size.height,
        scale: Math.min(2, window.devicePixelRatio || 1),
        active: document.visibilityState === "visible",
      } satisfies FlowWorkerMessage,
      [offscreen],
    );
  } catch {
    fallback.hidden = false;
    canvas.hidden = true;
  }

  const resizeObserver = new ResizeObserver((entries) => {
    const rect = entries[entries.length - 1]?.contentRect;
    if (!rect) return;
    size = { width: rect.width, height: rect.height };
    worker?.postMessage({
      type: "resize",
      width: size.width,
      height: size.height,
      scale: Math.min(2, window.devicePixelRatio || 1),
    } satisfies FlowWorkerMessage);
  });
  resizeObserver.observe(plot);

  const onVisibilityChange = (): void => {
    worker?.postMessage({ type: "active", active: document.visibilityState === "visible" });
  };
  const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
  document.addEventListener("visibilitychange", onVisibilityChange);
  colorScheme.addEventListener("change", sendSnapshot);

  return {
    destroy() {
      resizeObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      colorScheme.removeEventListener("change", sendSnapshot);
      worker?.terminate();
      worker = null;
    },

    showError(message) {
      error.hidden = message === null;
      errorTitle.textContent = message === null ? "" : t("dashboard-error-generic");
      errorMessage.textContent = message ?? "";
    },

    update(view, selected) {
      latestView = view;
      latestSelected = selected;
      const hasGraph = view.sessions.some(
        (session) =>
          !session.id.startsWith("other:")
          && session.state !== "cold"
          && (session.rate_per_min > 0 || session.state === "streaming"),
      );
      if (graphSection) graphSection.hidden = !hasGraph;
      canvas.dataset.selectedSessionId = selected ?? "";
      canvas.dataset.motion = reducedMotion() ? "static" : "animated";

      const sessions = view.sessions.filter((session) => !session.id.startsWith("other:"));
      const activeSessions = sessions.filter((session) => session.state !== "cold");
      const rateSessions = view.sessions.filter((session) => session.rate_per_min > 0);
      const rate = rateSessions.reduce((sum, session) => sum + session.rate_per_min, 0);
      const knownRates = rateSessions.flatMap((session) => (session.rates ? [session.rates] : []));
      const totals = knownRates.reduce(
        (sum, rates) => ({
          input: sum.input + rates.input_per_min,
          output: sum.output + rates.output_per_min,
          cacheRead: sum.cacheRead + rates.cache_read_per_min,
          cacheWrite: sum.cacheWrite + rates.cache_write_per_min,
        }),
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      );
      const inputTotal = totals.input + totals.cacheRead + totals.cacheWrite;
      const locale = resolveLocale();
      numbers = new Intl.NumberFormat(locale);
      compactNumbers = new Intl.NumberFormat(locale, {
        notation: "compact",
        maximumFractionDigits: 1,
      });
      const rateText = (value: number): string =>
        Math.abs(value) >= 1_000_000 ? compactNumbers.format(value) : numbers.format(Math.round(value));
      const setRate = (node: HTMLElement, value: number | null): void => {
        node.textContent = value === null ? "—" : rateText(value);
        node.title = value === null ? "" : `${numbers.format(Math.round(value))} ${t("dashboard-live-unit")}`;
      };
      setRate(primaryValue, rate);
      const hasRates = knownRates.length > 0;
      setRate(inputRate.value, hasRates ? totals.input : null);
      setRate(outputRate.value, hasRates ? totals.output : null);
      setRate(cacheReadRate.value, hasRates ? totals.cacheRead : null);
      setRate(cacheWriteRate.value, hasRates ? totals.cacheWrite : null);
      cacheHitValue.textContent = inputTotal > 0 ? `${Math.round((totals.cacheRead / inputTotal) * 100)}%` : "—";

      const liveCount = activeSessions.length;
      const coldCount = sessions.length - liveCount;
      canvas.setAttribute(
        "aria-label",
        t("dashboard-flow-summary", {
          rate: numbers.format(Math.round(rate)),
          live: numbers.format(liveCount),
          cold: numbers.format(coldCount),
        }),
      );
      sendSnapshot();
    },
  };
}
