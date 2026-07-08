/**
 * Client-side i18n runtime — ICU MessageFormat (the same message syntax Apple
 * String Catalogs and .NET localize with), rendered by intl-messageformat.
 *
 * This module is the SHARED catalog + resolution layer, deliberately decoupled
 * from any one UI surface: it only knows locale tags and keys, never the DOM.
 * The Settings webview binds it to markup via `applyI18n()` in main.ts; a
 * future dashboard runtime (or any other surface) can import the same `en.json`
 * and `t()` unchanged — nothing here assumes Settings. Keep it that way when
 * extending (no Settings-only keys carved out, no Settings-only wiring).
 *
 * `en` is the base catalog and the single source of truth for every key. The
 * other locales are OVERRIDE catalogs: they carry only the keys they translate
 * and fall back through the resource chain below. A regional file (`es-MX`)
 * need only hold the handful of terms it diverges on; everything else resolves
 * to its language (`es`) and finally to `en`.
 *
 *   lookup order for a key:  <region>  →  <language>  →  en
 *   e.g. "es-MX" → "es" → "en"
 *
 * A key missing from every catalog renders as the key itself (fails visibly,
 * never throws over a UI string).
 *
 * Two OS-conditional terms live in the catalog as an ICU `select` on an `os`
 * argument (normalized to macos|windows|linux by osKind()):
 *   - `file-manager`  → Finder / File Explorer / Files   (used here, in JS)
 *   - `app-container` → menu bar / system tray            (mirrored trivially
 *       in Rust — shell/src-tauri/src/lib.rs — via cfg!(target_os); both sides
 *       are kept in sync with THIS catalog by tests/i18n-catalog-parity.test.ts)
 *
 * Rule (why this can't back us into a corner): a term is NEVER concatenated
 * into a sentence — it is passed as an ICU argument (`Reveal logs in
 * {fileManager}`) so word order stays translatable across languages.
 */
import { IntlMessageFormat } from "intl-messageformat";

import { osKind } from "../ui/platform";
import en from "./en.json";
import enGB from "./en-GB.json";
import es from "./es.json";
import esES from "./es-ES.json";
import esMX from "./es-MX.json";

type Catalog = Record<string, string>;

/**
 * All shippable catalogs. `en` is fully populated (the base); the rest are
 * sparse overrides filled by the translation pass. The KEYS of this map are
 * the available locale tags a user can pick — keep them in BCP-47 form so the
 * best-fit matcher and the picker can reason about language vs region.
 */
const CATALOGS: Record<string, Catalog> = {
  en,
  "en-GB": enGB,
  es,
  "es-MX": esMX,
  "es-ES": esES,
};

/** Human labels for the picker, keyed by locale tag. */
const LOCALE_LABELS: Record<string, string> = {
  en: "English (US)",
  "en-GB": "English (UK)",
  es: "Español",
  "es-MX": "Español (México)",
  "es-ES": "Español (España)",
};

/** localStorage key holding the user's explicit locale override, if any. */
const LOCALE_OVERRIDE_KEY = "maximal.locale";

/** The locale tags this build ships, in declared order. */
export function availableLocales(): string[] {
  return Object.keys(CATALOGS);
}

/** Human label for a locale tag (falls back to the tag itself). */
export function localeLabel(tag: string): string {
  return LOCALE_LABELS[tag] ?? tag;
}

function readOverride(): string | null {
  try {
    return globalThis.localStorage?.getItem(LOCALE_OVERRIDE_KEY) ?? null;
  } catch {
    // localStorage can throw (privacy mode, disabled storage); treat as unset.
    return null;
  }
}

/** Persist an explicit locale override and use it on the next resolve. */
export function setLocale(tag: string): void {
  try {
    globalThis.localStorage?.setItem(LOCALE_OVERRIDE_KEY, tag);
  } catch {
    // Non-fatal: the picker still re-renders live for this session.
  }
}

/** The language subtag of a BCP-47 tag (`es-MX` → `es`). */
function languageOf(tag: string): string {
  return tag.split("-", 1)[0] ?? tag;
}

/**
 * Best-fit `navigator.languages` against the available locales: try each
 * preferred tag as a full match first (`es-MX`), then language-only (`es`),
 * in preference order. Returns null when nothing matches.
 */
function bestFitFromNavigator(available: string[]): string | null {
  const availableSet = new Set(available);
  const byLanguage = new Map<string, string>();
  // First declared locale per language wins as the language-only fallback
  // (so `es` maps to the base `es` catalog, not `es-MX`).
  for (const tag of available) {
    const lang = languageOf(tag);
    if (!byLanguage.has(lang)) byLanguage.set(lang, tag);
  }

  const preferred =
    typeof navigator === "undefined" ? [] : (navigator.languages ?? []);
  for (const raw of preferred) {
    if (availableSet.has(raw)) return raw;
    const lang = languageOf(raw);
    const langMatch = byLanguage.get(lang);
    if (langMatch) return langMatch;
  }
  return null;
}

/**
 * The active UI locale. Resolution order:
 *   (a) an explicit, persisted override (the picker) if it's a locale we ship;
 *   (b) a best-fit match of the browser's `navigator.languages`;
 *   (c) `"en"`.
 */
export function resolveLocale(): string {
  const available = availableLocales();
  const override = readOverride();
  if (override && available.includes(override)) return override;
  return bestFitFromNavigator(available) ?? "en";
}

/**
 * Resolve a message for a key through the resource-fallback chain of a locale:
 * region catalog → language catalog → base (`en`). Returns undefined only when
 * no catalog carries the key.
 */
function lookup(key: string, locale: string): string | undefined {
  const lang = languageOf(locale);
  return (
    CATALOGS[locale]?.[key] ??
    CATALOGS[lang]?.[key] ??
    CATALOGS.en[key]
  );
}

function format(key: string, values: Record<string, unknown>): string {
  const locale = resolveLocale();
  const message = lookup(key, locale);
  if (message === undefined) return key; // fail visibly, never throw over a UI string
  return new IntlMessageFormat(message, locale).format(values) as string;
}

/** The OS-appropriate file-manager noun: Finder / File Explorer / Files. */
export function fileManagerName(): string {
  return format("file-manager", { os: osKind() });
}

/**
 * Resolve a localized UI string. The current `os` and the resolved
 * `{fileManager}` noun are injected automatically, so a message can reference
 * `{fileManager}` without the caller wiring it up; pass any other placeholders
 * via `values`.
 */
export function t(key: string, values: Record<string, unknown> = {}): string {
  return format(key, { os: osKind(), fileManager: fileManagerName(), ...values });
}
