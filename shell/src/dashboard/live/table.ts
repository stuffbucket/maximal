// The Dashboard's session table: one row per session in the last 24 h, and the
// legend for the live card's traces (each live session's row carries its
// line color). Built once into a host that main.ts never re-renders, then
// updated in place on every poll and every countdown tick: rows are keyed by
// session id and moved, never rebuilt, so focus, hover and the selection
// survive.
//
// Styling reuses the per-request table's classes and the quota cards' `.meter`
// (see style.css → Session table for the few rules of its own).
import type { SessionsResponse } from "../../../../src/lib/token-usage/sessions-schema";
import { resolveLocale, t } from "../../i18n";
import { type Session, formatCountdown, sortSessions } from "./rows";

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

/** Context fill from which the meter warns, and from which it's an error. */
const CONTEXT_LOW = 75;
const CONTEXT_OUT = 90;

interface Row {
  tr: HTMLTableRowElement;
  swatchCell: HTMLTableCellElement;
  client: HTMLElement;
  clientSub: HTMLElement;
  model: HTMLElement;
  sessionSub: HTMLElement;
  state: HTMLElement;
  stateSub: HTMLElement;
  rate: HTMLElement;
  context: HTMLElement;
  meter: HTMLElement;
  meterFill: HTMLElement;
  meterState: HTMLElement;
  meterIcon: HTMLElement;
  meterText: HTMLElement;
  compacted: HTMLElement;
  last: HTMLElement;
  total: HTMLElement;
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

  const rows = new Map<string, Row>();
  let shownSelected: string | null = null;
  let shownPreview: string | null = null;

  function buildRow(id: string): Row {
    const tr = el("tr", "session-row border-b");
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
    const sessionSub = el("div", "text-xs truncate");
    sessionCell.append(model, sessionSub);

    const stateCell = cell("whitespace-nowrap session-cell--state");
    const state = el("div");
    const stateSub = el("div", "text-xs");
    stateCell.append(state, stateSub);

    const rate = cell("text-right whitespace-nowrap session-cell--num");

    const contextCell = cell("whitespace-nowrap");
    const context = el("div", "session-context");
    const meter = el("div", "meter");
    const meterFill = el("div", "meter__fill");
    meter.append(meterFill);
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
      state,
      stateSub,
      rate,
      context,
      meter,
      meterFill,
      meterState,
      meterIcon,
      meterText,
      compacted,
      last,
      total,
    };
  }

  function fillRow(
    row: Row,
    s: Session,
    slot: number | null,
    nowMs: number,
    locale: string,
    numbers: Intl.NumberFormat,
    clock: Intl.DateTimeFormat,
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
      setText(row.sessionSub, s.model);
      row.sessionSub.title = "";
    } else {
      setText(row.model, s.model);
      setText(
        row.sessionSub,
        `${t("dashboard-sessions-started", { time: clock.format(s.started_at_ms) })} · ${s.id.slice(0, 8)}`,
      );
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
      : t("dashboard-sessions-state-cold", { time: clock.format(expires ?? s.last_request_at_ms) });
    setText(row.state, stateText);
    setText(row.stateSub, s.cache.downgraded ? t("dashboard-sessions-downgraded") : "");

    setText(row.rate, numbers.format(Math.round(s.rate_per_min)));
    setText(row.last, clock.format(s.last_request_at_ms));
    setText(row.total, numbers.format(s.total_tokens));

    // Context: the meter fills against the smaller of the window and Copilot's
    // ceiling. "Other requests" mixes conversations, so it has none.
    const { used_tokens, window_tokens, ceiling_tokens, window_source, compacted_at_ms } = s.context;
    const windows = [window_tokens, ceiling_tokens].filter((n): n is number => n !== null && n > 0);
    const effective = other || windows.length === 0 ? null : Math.min(...windows);
    if (effective === null) {
      row.meter.hidden = true;
      row.meterIcon.hidden = true;
      row.meterState.className = "meter-state";
      setText(row.meterText, "—");
      row.context.title = "";
    } else {
      const percent = (used_tokens / effective) * 100;
      const level =
        percent >= CONTEXT_OUT ? "out"
        : percent >= CONTEXT_LOW ? "low"
        : "ok";
      row.meter.hidden = false;
      row.meter.className = `meter meter--${level}`;
      row.meterFill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
      row.meterState.className = `meter-state meter-state--${level}`;
      row.meterIcon.hidden = level === "ok";
      setText(
        row.meterText,
        new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(percent / 100),
      );
      row.context.title = t("dashboard-sessions-context-title", {
        used: numbers.format(used_tokens),
        window: numbers.format(effective),
        source: t(`dashboard-sessions-source-${window_source}`),
      });
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

  return {
    update(view, colors, selected, nowMs) {
      const locale = resolveLocale();
      const numbers = new Intl.NumberFormat(locale);
      const clock = new Intl.DateTimeFormat(locale, { timeStyle: "short" });
      const { above, below } = sortSessions(view.sessions);

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
        fillRow(row, s, colors.get(s.id) ?? null, nowMs, locale, numbers, clock);
        present.add(s.id);
        order.push(row.tr);
      };
      above.forEach(place);
      if (below.length > 0) {
        dividerCell.textContent = t("dashboard-sessions-cold-divider");
        order.push(divider);
        below.forEach(place);
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
}
