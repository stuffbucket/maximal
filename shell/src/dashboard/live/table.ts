// The Dashboard's session table: one row per session in the last 24 h, and the
// legend for the live card's traces (each live session's row carries its
// line color). Built once into a host that main.ts never re-renders, then
// updated in place on every poll and every countdown tick: rows are keyed by
// session id and moved, never rebuilt, so focus, hover and the selection
// survive.
//
// Cold sessions show the latest COLD_ROWS, then a "Show N more" button. A row
// is refilled only when its session changed, or when something in it reads
// the clock (a countdown, "compacted N min ago", a day name).
//
// Styling reuses the per-request table's classes and the quota cards' `.meter`
// (see style.css → Session table for the few rules of its own).
import type { SessionsResponse } from "../../../../src/lib/token-usage/sessions-schema";
import { resolveLocale, t } from "../../i18n";
import {
  COLD_ROWS,
  type Session,
  clockFormatter,
  coldRows,
  contextMeter,
  downgradedText,
  formatCountdown,
  sortSessions,
} from "./rows";

// Lucide is a classic global <script> in index.html (see main.ts).
declare const lucide: { createIcons: () => void } | undefined;

export interface SessionTable {
  update(
    view: SessionsResponse,
    colors: Map<string, number | null>,
    selected: string | null,
    nowMs: number,
  ): void;
  /** Show `id`'s row as previewed (its trace is under the pointer), or none. */
  preview(id: string | null): void;
}

/** Header keys, in column order; the numbers sit right-aligned. */
const COLUMNS: Array<{ key: string; numeric?: boolean; hidden?: boolean }> = [
  { key: "dashboard-sessions-col-color", hidden: true },
  { key: "dashboard-sessions-col-client" },
  { key: "dashboard-sessions-col-session" },
  { key: "dashboard-sessions-col-state" },
  { key: "dashboard-sessions-col-rate", numeric: true },
  { key: "dashboard-sessions-col-context" },
  { key: "dashboard-sessions-col-last" },
  { key: "dashboard-sessions-col-total", numeric: true },
];

/** The catalog's `select` cases for each client. */
const CLIENT_CASE: Record<Session["client"], string> = {
  "claude-code": "code",
  "claude-desktop": "desktop",
  codex: "codex",
  other: "other",
};

/** What a row was last filled from, so an unchanged row is skipped. */
interface Filled {
  session: Session;
  /** The session as JSON, compared when a poll brings a new object. */
  json: string;
  slot: number | null;
  locale: string;
  minute: number;
}

interface Row {
  tr: HTMLTableRowElement;
  swatchCell: HTMLTableCellElement;
  client: HTMLElement;
  clientSub: HTMLElement;
  model: HTMLElement;
  sessionSub: HTMLElement;
  started: HTMLElement;
  shortId: HTMLElement;
  state: HTMLElement;
  stateSub: HTMLElement;
  rate: HTMLElement;
  context: HTMLElement;
  meter: HTMLElement;
  meterFill: HTMLElement;
  ceilingTick: HTMLElement;
  compactTick: HTMLElement;
  meterState: HTMLElement;
  meterIcon: HTMLElement;
  meterText: HTMLElement;
  compacted: HTMLElement;
  last: HTMLElement;
  total: HTMLElement;
  filled: Filled | null;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

/** Text that shows only when there's something to say. */
function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
  node.hidden = text === "";
}

const isOther = (s: Session): boolean => s.id.startsWith("other:");

function formatAgo(ms: number, locale: string): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const [value, unit] = minutes < 60 ? [minutes, "minute"] : [Math.round(minutes / 60), "hour"];
  return new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "short" }).format(value);
}

export function mountSessionTable(
  root: HTMLElement,
  onSelect: (id: string | null) => void,
  onPreview: (id: string | null) => void,
): SessionTable {
  // The per-request table's frame: a bordered card, scrolling sideways on
  // narrow windows rather than squeezing the columns.
  const frame = el("div", "border");
  frame.style.backgroundColor = "var(--surface-card)";
  frame.style.borderColor = "var(--border-subtle)";
  const scroller = el("div", "overflow-auto");
  const table = el("table", "w-full min-w-[860px] text-left text-xs sm:text-sm");
  const thead = el("thead");
  thead.style.backgroundColor = "var(--surface-control)";
  thead.style.color = "var(--text-base-color)";
  const headRow = el("tr");
  for (const column of COLUMNS) {
    const th = el("th", `px-4 py-2 font-semibold whitespace-nowrap${column.numeric ? " text-right" : ""}`);
    th.scope = "col";
    const label = el("span", column.hidden ? "sr-only" : "");
    label.dataset.i18n = column.key;
    label.textContent = t(column.key);
    th.append(label);
    headRow.append(th);
  }
  thead.append(headRow);
  const tbody = el("tbody");
  table.append(thead, tbody);
  scroller.append(table);
  frame.append(scroller);
  root.replaceChildren(frame);

  const divider = el("tr", "session-divider");
  const dividerCell = el("td");
  dividerCell.colSpan = COLUMNS.length;
  dividerCell.dataset.i18n = "dashboard-sessions-cold-divider";
  dividerCell.textContent = t("dashboard-sessions-cold-divider");
  divider.append(dividerCell);

  // "Show N more" under the cold rows; once pressed, every cold row shows.
  const more = el("tr", "session-more");
  const moreCell = el("td", "px-4 py-2");
  moreCell.colSpan = COLUMNS.length;
  const moreButton = el("button", "session-more__button");
  moreButton.type = "button";
  moreCell.append(moreButton);
  more.append(moreCell);
  let coldExpanded = false;
  /** The first cold row the button revealed, which takes the focus. */
  let revealFocus: string | null = null;

  const rows = new Map<string, Row>();
  let shownSelected: string | null = null;
  let shownPreview: string | null = null;
  let lastArgs: Parameters<SessionTable["update"]> | null = null;

  function buildRow(id: string): Row {
    const tr = el("tr", "session-row border-b last:border-b-0");
    tr.style.borderColor = "var(--surface-control)";
    tr.dataset.sessionId = id;
    tr.tabIndex = 0;
    tr.addEventListener("click", () => onSelect(id));
    tr.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      onSelect(id);
    });
    tr.addEventListener("pointerenter", () => onPreview(id));
    tr.addEventListener("pointerleave", () => onPreview(null));
    tr.addEventListener("focus", () => onPreview(id));
    tr.addEventListener("blur", () => onPreview(null));

    const cell = (extra = ""): HTMLTableCellElement => {
      const td = el("td", `px-4 py-2 ${extra}`.trim());
      tr.append(td);
      return td;
    };

    const swatchCell = cell("session-cell--swatch");

    const clientCell = cell("whitespace-nowrap");
    const client = el("div", "session-strong");
    const clientSub = el("div", "text-xs");
    clientCell.append(client, clientSub);

    const sessionCell = cell("max-w-[280px]");
    const model = el("div", "session-strong truncate");
    // "started 12:30 AM" and the short id sit side by side as their own
    // spans, so no wording is joined in code.
    const sessionSub = el("div", "text-xs truncate");
    const started = el("span");
    const shortId = el("span", "ml-2");
    sessionSub.append(started, shortId);
    sessionCell.append(model, sessionSub);

    const stateCell = cell("whitespace-nowrap session-cell--state");
    const state = el("div");
    const stateSub = el("div", "text-xs whitespace-normal");
    stateCell.append(state, stateSub);

    const rate = cell("text-right whitespace-nowrap session-cell--num");

    const contextCell = cell("whitespace-nowrap");
    const context = el("div", "session-context");
    const meter = el("div", "meter");
    const meterFill = el("div", "meter__fill");
    const ceilingTick = el("div", "meter__tick meter__tick--ceiling");
    const compactTick = el("div", "meter__tick meter__tick--compact");
    meter.append(meterFill, ceilingTick, compactTick);
    const meterState = el("span", "meter-state");
    const meterIcon = el("span", "session-context__icon");
    meterIcon.innerHTML = `<i data-lucide="triangle-alert" aria-hidden="true"></i>`;
    const meterText = el("span");
    meterState.append(meterIcon, meterText);
    context.append(meter, meterState);
    const compacted = el("div", "text-xs");
    contextCell.append(context, compacted);

    const last = cell("whitespace-nowrap session-cell--num");
    const total = cell("text-right whitespace-nowrap session-cell--num");

    return {
      tr,
      swatchCell,
      client,
      clientSub,
      model,
      sessionSub,
      started,
      shortId,
      state,
      stateSub,
      rate,
      context,
      meter,
      meterFill,
      ceilingTick,
      compactTick,
      meterState,
      meterIcon,
      meterText,
      compacted,
      last,
      total,
      filled: null,
    };
  }

  /** Place a tick at `at` percent of the meter, or hide it. */
  function setTick(tick: HTMLElement, at: number | null): void {
    tick.hidden = at === null;
    if (at !== null) tick.style.left = `${at}%`;
  }

  /** Whether the row must be filled again: its session, color or locale
   *  changed, or it shows something that reads the clock. */
  function stale(row: Row, s: Session, slot: number | null, locale: string, minute: number): boolean {
    const { filled } = row;
    if (!filled || filled.slot !== slot || filled.locale !== locale) return true;
    // A countdown ticks every second; "N min ago" and day names every minute.
    if (s.state === "warm" || filled.minute !== minute) return true;
    if (filled.session === s) return false;
    const json = JSON.stringify(s);
    if (json !== filled.json) return true;
    filled.session = s;
    return false;
  }

  function fillRow(
    row: Row,
    s: Session,
    slot: number | null,
    nowMs: number,
    locale: string,
    numbers: Intl.NumberFormat,
    clock: (ms: number, nowMs: number) => string,
  ): void {
    const other = isOther(s);
    row.tr.classList.toggle("session-row--cold", s.state === "cold");

    // The swatch is this row's line color; no trace, no swatch.
    const swatch = row.swatchCell.firstElementChild as HTMLElement | null;
    const color = s.state !== "cold" && !other && slot !== null ? `var(--series-${slot})` : null;
    if (color === null) {
      swatch?.remove();
    } else {
      const node = swatch ?? row.swatchCell.appendChild(el("span", "session-swatch"));
      node.setAttribute("aria-hidden", "true");
      node.style.setProperty("--swatch-color", color);
    }

    const clientName = t("dashboard-sessions-client", { client: CLIENT_CASE[s.client] });
    const label = s.client_label?.trim() || "";
    setText(row.client, label || clientName);
    setText(row.clientSub, label && label !== clientName ? clientName : "");

    if (other) {
      setText(row.model, t("dashboard-sessions-other"));
      setText(row.started, s.model);
      setText(row.shortId, "");
      row.sessionSub.title = "";
    } else {
      setText(row.model, s.model);
      setText(row.started, t("dashboard-sessions-started", { time: clock(s.started_at_ms, nowMs) }));
      setText(row.shortId, s.id.slice(0, 8));
      row.sessionSub.title = s.id;
    }
    row.model.title = s.model;

    const expires = s.cache.expires_at_ms;
    const stateText =
      s.state === "streaming" ? t("dashboard-sessions-state-streaming")
      : s.state === "warm" ?
        t("dashboard-sessions-state-warm", {
          time: expires === null ? "—" : formatCountdown(expires - nowMs, s.cache.confidence, locale),
        })
      : t("dashboard-sessions-state-cold", { time: clock(expires ?? s.last_request_at_ms, nowMs) });
    setText(row.state, stateText);
    const downgradedFrom = s.cache.downgraded ? s.cache.downgraded_from_s : null;
    setText(row.stateSub, downgradedFrom === null ? "" : downgradedText(downgradedFrom, locale));

    setText(row.rate, numbers.format(Math.round(s.rate_per_min)));
    setText(row.last, clock(s.last_request_at_ms, nowMs));
    setText(row.total, numbers.format(s.total_tokens));

    // Context: the percent is of the smaller of the window and Copilot's
    // ceiling; a lower ceiling and a compaction point are ticks on the track.
    // "Other requests" mixes conversations, so it has none.
    const { compacted_at_ms } = s.context;
    const meter = other ? null : contextMeter(s.context, locale);
    if (meter === null) {
      row.meter.hidden = true;
      row.meterIcon.hidden = true;
      row.meterState.className = "meter-state";
      setText(row.meterText, "—");
      row.context.title = "";
    } else {
      row.meter.hidden = false;
      row.meter.className = `meter meter--${meter.level}`;
      row.meterFill.style.width = `${meter.fill}%`;
      setTick(row.ceilingTick, meter.ceilingAt);
      setTick(row.compactTick, meter.compactAt);
      row.meterState.className = `meter-state meter-state--${meter.level}`;
      row.meterIcon.hidden = meter.level === "ok";
      setText(
        row.meterText,
        new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(meter.percent / 100),
      );
      row.context.title = meter.title;
    }
    setText(
      row.compacted,
      compacted_at_ms === null || other ?
        ""
      : t("dashboard-sessions-compacted", { time: formatAgo(nowMs - compacted_at_ms, locale) }),
    );
  }

  function markRows(): void {
    for (const [id, row] of rows) {
      const isSelected = id === shownSelected;
      row.tr.classList.toggle("session-row--selected", isSelected);
      row.tr.classList.toggle("session-row--preview", id === shownPreview && !isSelected);
      if (isSelected) row.tr.setAttribute("aria-current", "true");
      else row.tr.removeAttribute("aria-current");
    }
  }

  const api: SessionTable = {
    update(view, colors, selected, nowMs) {
      lastArgs = [view, colors, selected, nowMs];
      const locale = resolveLocale();
      const numbers = new Intl.NumberFormat(locale);
      const clock = clockFormatter(locale);
      const minute = Math.floor(nowMs / 60_000);
      const { above, below } = sortSessions(view.sessions);
      const cold = coldRows(below, coldExpanded);

      let added = false;
      const order: Array<HTMLTableRowElement> = [];
      const present = new Set<string>();
      const place = (s: Session): void => {
        let row = rows.get(s.id);
        if (!row) {
          row = buildRow(s.id);
          rows.set(s.id, row);
          added = true;
        }
        const slot = colors.get(s.id) ?? null;
        if (stale(row, s, slot, locale, minute)) {
          fillRow(row, s, slot, nowMs, locale, numbers, clock);
          row.filled = { session: s, json: JSON.stringify(s), slot, locale, minute };
        }
        present.add(s.id);
        order.push(row.tr);
      };
      above.forEach(place);
      if (below.length > 0) {
        setText(dividerCell, t("dashboard-sessions-cold-divider"));
        order.push(divider);
        cold.shown.forEach(place);
      }
      if (cold.hidden > 0) {
        setText(moreButton, t("dashboard-sessions-show-more", { count: numbers.format(cold.hidden) }));
        order.push(more);
      }
      for (const id of rows.keys()) {
        if (!present.has(id)) rows.delete(id);
      }

      // Move only what's out of place, so a focused row usually stays put; if
      // a move drops focus, give it back without scrolling.
      const focused = document.activeElement;
      order.forEach((tr, i) => {
        const at = tbody.children[i] ?? null;
        if (at !== tr) tbody.insertBefore(tr, at);
      });
      while (tbody.children.length > order.length) tbody.lastElementChild?.remove();
      if (focused instanceof HTMLElement && focused !== document.activeElement && tbody.contains(focused)) {
        focused.focus({ preventScroll: true });
      }
      // The button is gone once pressed: the first row it revealed takes the focus.
      const revealed = revealFocus === null ? undefined : rows.get(revealFocus);
      revealFocus = null;
      revealed?.tr.focus({ preventScroll: true });
      if (added && typeof lucide !== "undefined" && lucide) lucide.createIcons();

      const changed = selected !== shownSelected;
      shownSelected = selected;
      markRows();
      // A selection made on the plot brings its row into view.
      const row = selected === null ? undefined : rows.get(selected);
      if (changed && row) {
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        row.tr.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reduce ? "auto" : "smooth" });
      }
    },

    preview(id) {
      if (id === shownPreview) return;
      shownPreview = id;
      markRows();
    },
  };

  moreButton.addEventListener("click", () => {
    if (!lastArgs) return;
    const [view] = lastArgs;
    revealFocus = sortSessions(view.sessions).below[COLD_ROWS]?.id ?? null;
    coldExpanded = true;
    api.update(...lastArgs);
  });

  return api;
}
