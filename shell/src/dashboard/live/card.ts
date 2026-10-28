// The Dashboard's live card: total tokens/min, one trace per live session over
// the last 15 minutes, and a chasing border whose speed follows token flow.
//
// main.ts re-renders the page from strings, so the card is built once into a
// host element that survives those renders, and every poll updates the paths,
// dots, numbers and border speed in place. The caller owns the series colors
// (one SeriesColors shared with the session table) and the selection.
import type { SessionsResponse, SessionView } from "../../../../src/lib/token-usage/sessions-schema";
import { resolveLocale, t } from "../../i18n";
import { borderPeriodS, shiftWindow, tracePath } from "./geometry";

export interface LiveCard {
  update(view: SessionsResponse, colors: Map<string, number | null>, selected: string | null): void;
  /** Say the sessions couldn't be read (`null` clears it). What's drawn stays. */
  showError(message: string | null): void;
}

const SVG_NS = "http://www.w3.org/2000/svg";
/** One-minute buckets on the plot, oldest first. */
const WINDOW_MINUTES = 15;
const MINUTE_MS = 60_000;
/** How long the lines, dots and figure glide to a new poll's values. */
const GLIDE_MS = 900;
/** The border's speed moves to a new flow's over this long. */
const BORDER_EASE_MS = 3000;
/** The CSS animation's own duration; speed is set as a playback rate on it,
 *  which keeps the angle continuous where changing the duration would jump. */
const BORDER_BASE_PERIOD_S = 30;
/** Room for the end dot inside the plot, so it never clips at an edge. */
const DOT_INSET = 5;
/** Gives every trace's gradient an id of its own: ids are document-wide, so a
 *  shared one would point every fill at whichever gradient came first. */
let gradientSeq = 0;

interface TraceState {
  g: SVGGElement;
  /** This session's gradient fill: its own <linearGradient> and area path. */
  fill: SVGGElement;
  area: SVGPathElement;
  line: SVGPathElement;
  hit: SVGPathElement;
  dot: SVGGElement;
  /** Values on screen now, and where they are gliding to. */
  from: Array<number>;
  to: Array<number>;
  shown: Array<number>;
  /** start_ms of the latest bucket, to line up the next poll's buckets. */
  lastStart: number;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
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

/** The last 15 buckets' tokens, left-padded with zeros so every trace shares the axis. */
function bucketValues(session: SessionView): Array<number> {
  const values = session.minutes.slice(-WINDOW_MINUTES).map((m) => Math.max(0, m.total_tokens));
  return [...Array<number>(WINDOW_MINUTES - values.length).fill(0), ...values];
}

/** Sessions that get a trace: above the line, and a real session. */
function isTraced(session: SessionView): boolean {
  return session.state !== "cold" && !session.id.startsWith("other:");
}

const easeOut = (x: number): number => 1 - (1 - x) ** 3;
const easeInOut = (x: number): number => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2);

export function mountLiveCard(root: HTMLElement): LiveCard {
  root.classList.add("live", "live--border");
  root.replaceChildren();

  const inner = html("div", "live__inner");

  const head = html("div", "live__head");
  const metric = html("div", "live__metric");
  const value = html("span", "live__value totals__hero-value");
  value.textContent = "0";
  metric.append(value, html("span", "live__unit", "dashboard-live-unit"));
  head.append(metric, html("span", "live__window", "dashboard-live-window"));

  const plot = html("div", "live__plot");
  const chart = svg("svg", { class: "live__chart", role: "img" });
  // Fills sit under every line, so no session's fill covers another's trace.
  const fills = svg("g", { class: "live__fills" });
  const traces = svg("g", { class: "live__traces" });
  chart.append(fills, traces);
  plot.append(chart);

  const foot = html("div", "live__foot");
  const counts = html("span", "live__counts");
  const marker = html("span", "live__marker");
  const pulse = html("span", "live__pulse");
  pulse.setAttribute("aria-hidden", "true");
  marker.append(pulse, html("span", "live__marker-label", "dashboard-live-marker"));
  foot.append(counts, marker);

  // A failed read, worded like the page's other errors (renderError in main.ts):
  // the generic title, then what went wrong. Text, not a box: no card in a card.
  const error = html("p", "live__error");
  error.setAttribute("role", "alert");
  error.hidden = true;
  const errorTitle = html("span", "live__error-title");
  const errorMessage = html("span", "live__error-message");
  error.append(errorTitle, errorMessage);

  inner.append(head, error, plot, foot);
  root.append(inner);

  const byId = new Map<string, TraceState>();
  let selectedId: string | null = null;
  let size = { width: 0, height: 0 };

  let rateFrom = 0;
  let rateTo = 0;
  let rateShown = 0;
  let glideStart = 0;
  let gliding = false;

  /** Border speed in turns per second, eased from `speedFrom` to the target. */
  let speed = 0;
  let speedFrom = 0;
  let speedTarget = 0;
  let speedEaseStart = 0;
  let frame: number | null = null;

  /** Set on each update, so a language switch shows on the next poll. */
  let numbers = new Intl.NumberFormat(resolveLocale());

  function plotBox(): { width: number; height: number } {
    return {
      width: Math.max(0, size.width - DOT_INSET),
      height: Math.max(0, size.height - 2 * DOT_INSET),
    };
  }

  /** Redraw every trace, the fill and the dots from the values on screen. */
  function draw(): void {
    const box = plotBox();
    if (box.width <= 0 || box.height <= 0) return;
    let max = 1;
    for (const tr of byId.values()) {
      for (const v of tr.shown) if (Number.isFinite(v)) max = Math.max(max, v);
    }
    for (const tr of byId.values()) {
      const path = tracePath(tr.shown, max, box.width, box.height);
      tr.line.setAttribute("d", path.line);
      tr.area.setAttribute("d", path.area);
      tr.hit.setAttribute("d", path.line);
      tr.dot.setAttribute("transform", `translate(${path.last[0].toFixed(2)} ${path.last[1].toFixed(2)})`);
    }
    value.textContent = numbers.format(Math.round(rateShown));
  }

  function tick(now: number): void {
    frame = null;

    if (gliding) {
      const p = Math.min(1, (now - glideStart) / GLIDE_MS);
      const k = easeOut(p);
      for (const tr of byId.values()) {
        tr.shown = tr.to.map((v, i) => tr.from[i] + (v - tr.from[i]) * k);
      }
      rateShown = rateFrom + (rateTo - rateFrom) * k;
      if (p >= 1) gliding = false;
      draw();
    }

    // Ease in speed (turns/s), so a stop glides to rest and a start picks up.
    if (speed !== speedTarget) {
      const p = Math.min(1, (now - speedEaseStart) / BORDER_EASE_MS);
      speed = p >= 1 ? speedTarget : speedFrom + (speedTarget - speedFrom) * easeInOut(p);
      applySpeed();
    }

    if (gliding || speed !== speedTarget) frame = requestAnimationFrame(tick);
  }

  function schedule(): void {
    if (frame === null) frame = requestAnimationFrame(tick);
  }

  /** Set the border's period on the element and its running animation. */
  function applySpeed(): void {
    if (speed <= 0) {
      root.style.removeProperty("--live-period");
      root.style.animationPlayState = "paused";
      return;
    }
    root.style.setProperty("--live-period", `${(1 / speed).toFixed(2)}s`);
    root.style.animationPlayState = "running";
    for (const animation of root.getAnimations()) {
      animation.playbackRate = speed * BORDER_BASE_PERIOD_S;
    }
  }

  function traceFor(id: string): TraceState {
    const existing = byId.get(id);
    if (existing) return existing;
    // The gradient lives inside the fill group so its stops inherit that
    // group's --trace-color, the same series color the line draws in.
    const gradientId = `live-fill-${++gradientSeq}`;
    const fill = svg("g", { class: "live__fill" });
    fill.dataset.sessionId = id;
    const gradient = svg("linearGradient", { id: gradientId, x1: "0", y1: "0", x2: "0", y2: "1" });
    gradient.append(
      svg("stop", { offset: "0", class: "live__fill-stop live__fill-stop--top" }),
      svg("stop", { offset: "1", class: "live__fill-stop live__fill-stop--bottom" }),
    );
    const area = svg("path", { class: "live__area", fill: `url(#${gradientId})` });
    fill.append(gradient, area);
    fills.append(fill);
    const g = svg("g", { class: "live__trace" });
    g.dataset.sessionId = id;
    const line = svg("path", { class: "live__line" });
    const hit = svg("path", { class: "live__hit" });
    const dot = svg("g", { class: "live__dot" });
    dot.append(svg("circle", { class: "live__dot-hit", r: "12" }), svg("circle", { class: "live__dot-mark", r: "3.5" }));
    g.append(line, hit, dot);
    traces.append(g);
    const state: TraceState = { g, fill, area, line, hit, dot, from: [], to: [], shown: [], lastStart: 0 };
    byId.set(id, state);
    return state;
  }

  // The animation (re)starts when the card is first shown; give it the
  // current speed rather than the stylesheet's base period.
  root.addEventListener("animationstart", (event) => {
    if (event.target === root) applySpeed();
  });

  new ResizeObserver((entries) => {
    const rect = entries[entries.length - 1]?.contentRect;
    if (!rect) return;
    size = { width: rect.width, height: rect.height };
    chart.setAttribute("viewBox", `0 0 ${size.width} ${size.height}`);
    traces.setAttribute("transform", `translate(0 ${DOT_INSET})`);
    fills.setAttribute("transform", `translate(0 ${DOT_INSET})`);
    draw();
  }).observe(plot);

  return {
    showError(message) {
      error.hidden = message === null;
      errorTitle.textContent = message === null ? "" : t("dashboard-error-generic");
      errorMessage.textContent = message ?? "";
    },

    update(view, colors, selected) {
      const instant = reducedMotion();
      const traced = view.sessions.filter(isTraced);
      const live = new Set(traced.map((s) => s.id));

      for (const [id, tr] of byId) {
        if (!live.has(id)) {
          tr.g.remove();
          tr.fill.remove();
          byId.delete(id);
        }
      }

      for (const session of traced) {
        const tr = traceFor(session.id);
        const target = bucketValues(session);
        const lastStart = session.minutes[session.minutes.length - 1]?.start_ms ?? 0;
        if (tr.shown.length === 0 || instant) {
          // First sight: draw it where it is, no rise from the baseline.
          tr.shown = target;
        } else if (lastStart !== tr.lastStart && tr.lastStart > 0) {
          // A minute rolled over: line the old values up with the new buckets.
          tr.shown = shiftWindow(tr.shown, target, (lastStart - tr.lastStart) / MINUTE_MS);
        }
        tr.from = tr.shown;
        tr.to = target;
        tr.lastStart = lastStart;

        const slot = colors.get(session.id) ?? null;
        const color = slot === null ? "var(--border-strong)" : `var(--series-${slot})`;
        const dim = selected !== null && live.has(selected) && session.id !== selected;
        for (const el of [tr.g, tr.fill]) el.style.setProperty("--trace-color", color);
        tr.g.classList.toggle("live__trace--neutral", slot === null);
        tr.g.classList.toggle("live__trace--selected", session.id === selected);
        for (const el of [tr.g, tr.fill]) el.classList.toggle("live__trace--dim", dim);
      }

      // The selected trace draws on top of the others.
      const selectedTrace = selected === null ? undefined : byId.get(selected);
      if (selectedTrace && selected !== selectedId) {
        traces.append(selectedTrace.g);
        fills.append(selectedTrace.fill);
      }
      selectedId = selected;

      const rate = view.sessions.reduce((sum, s) => sum + s.rate_per_min, 0);
      rateFrom = rateShown;
      rateTo = rate;

      const sessions = view.sessions.filter((s) => !s.id.startsWith("other:"));
      const liveCount = sessions.filter((s) => s.state !== "cold").length;
      const coldCount = sessions.length - liveCount;
      numbers = new Intl.NumberFormat(resolveLocale());
      const fmt = numbers;
      counts.textContent = t("dashboard-live-footer", { live: fmt.format(liveCount), cold: fmt.format(coldCount) });
      chart.setAttribute(
        "aria-label",
        t("dashboard-live-summary", {
          rate: fmt.format(Math.round(rate)),
          live: fmt.format(liveCount),
          cold: fmt.format(coldCount),
        }),
      );
      root.classList.toggle("live--flowing", view.flow_per_min > 0);

      const period = borderPeriodS(view.flow_per_min);
      const target = period === null ? 0 : 1 / period;
      if (target !== speedTarget) {
        speedFrom = speed;
        speedTarget = target;
        speedEaseStart = performance.now();
      }

      if (instant) {
        for (const tr of byId.values()) tr.shown = tr.to;
        rateShown = rate;
        gliding = false;
        speed = speedTarget;
        applySpeed();
        draw();
        return;
      }
      glideStart = performance.now();
      gliding = true;
      draw();
      schedule();
    },
  };
}
