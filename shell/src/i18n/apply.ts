import { invoke } from "@tauri-apps/api/core"

/**
 * Shared DOM binder for the i18n runtime — used by BOTH webview surfaces
 * (Settings via shell/src/main.ts, Dashboard via shell/ui/dashboard/main.ts).
 *
 * This is the surface-agnostic half of the i18n layer: it walks a DOM subtree
 * and fills `[data-i18n]` text + `[data-i18n-<attr>]` attributes from the
 * catalog (`./index`), and wires a `<select data-locale-select>` picker. It
 * holds NO surface-specific state — the per-surface "repaint the JS-composed
 * strings after a locale change" step is passed in as the picker's `onChange`
 * callback, so neither surface's dynamic-render logic leaks in here.
 */
import {
  availableLocales,
  localeLabel,
  resolveLocale,
  setLocale,
  t,
} from "./index"

/**
 * Push the active locale across the IPC boundary so the Tauri shell's
 * native chrome (tray menu, tooltip, notifications, window titles, quit
 * dialog) follows the same language as the webview. Best-effort: this also
 * runs in the non-Tauri/dev context (or before the command exists), where
 * `invoke` rejects — swallow it so a missing native side never breaks the
 * webview's own re-render.
 */
function syncNativeLocale(tag: string): void {
  void invoke("set_locale", { tag }).catch((err: unknown) => {
    console.warn("invoke(set_locale) failed:", err)
  })
}

/**
 * Localized ATTRIBUTES: a `data-i18n-<attr>` dataset key names the catalog key
 * whose text fills the real attribute. Extend by adding a row — no new block.
 */
const I18N_ATTRS: ReadonlyArray<{ attr: string; dataset: keyof DOMStringMap }> =
  [
    { attr: "aria-label", dataset: "i18nAriaLabel" },
    { attr: "title", dataset: "i18nTitle" },
    { attr: "placeholder", dataset: "i18nPlaceholder" },
  ]

/**
 * Populate every `[data-i18n]` element's text and every `[data-i18n-<attr>]`
 * element's attribute from the localized catalog. The key auto-injects the
 * current `os` and resolved `{fileManager}` noun, so a button marked
 * `data-i18n="reveal-logs"` renders "Reveal logs in Finder" / "… in File
 * Explorer" / "… in Files" per OS. General on purpose: any element carrying an
 * attribute is filled, so future catalog-backed labels need no extra wiring.
 *
 * Idempotent + re-runnable: the locale picker calls it again on every change to
 * repaint the whole UI live, and it is run on freshly-cloned rows to fill their
 * templated labels. Run at boot before first paint so no empty control flashes.
 */
export function applyI18n(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = el.dataset.i18n
    if (!key) continue
    // `data-i18n-count` on the same element feeds an ICU `plural` — e.g. the
    // dashboard period buttons: data-i18n="dashboard-period-days" +
    // data-i18n-count="7" → "7 days". Absent → no count arg (the common case).
    const count = el.dataset.i18nCount
    el.textContent = count === undefined ? t(key) : t(key, { n: Number(count) })
  }
  for (const { attr, dataset } of I18N_ATTRS) {
    for (const el of root.querySelectorAll<HTMLElement>(
      `[data-i18n-${attr}]`,
    )) {
      const key = el.dataset[dataset]
      if (key) el.setAttribute(attr, t(key))
    }
  }
}

/**
 * Populate a locale picker (`<select data-locale-select>`): one <option> per
 * shipped locale, labelled for humans, with the resolved locale pre-selected.
 * On change it persists the override, re-sweeps `[data-i18n]` across the whole
 * document, then calls `onChange` so the surface can re-render its JS-composed
 * strings (Settings: the link/token sentences + live account/diagnostics;
 * Dashboard: its render()). Adding the listener once is safe — populate runs
 * once at boot. No-op if the surface has no picker in its markup.
 *
 * Also syncs the resolved locale to the native shell once at boot (so the tray
 * and titles match the webview from first paint) and again on every change.
 */
export function wireLocalePicker(onChange: () => void): void {
  const select = document.querySelector<HTMLSelectElement>(
    "[data-locale-select]",
  )
  if (!select) return
  const active = resolveLocale()
  syncNativeLocale(active)
  select.replaceChildren()
  for (const tag of availableLocales()) {
    const opt = document.createElement("option")
    opt.value = tag
    opt.textContent = localeLabel(tag)
    opt.selected = tag === active
    select.append(opt)
  }
  select.addEventListener("change", () => {
    setLocale(select.value)
    syncNativeLocale(select.value)
    applyI18n(document)
    onChange()
  })
}
