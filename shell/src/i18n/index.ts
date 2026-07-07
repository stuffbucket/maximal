/**
 * Client-side i18n for the settings webview — ICU MessageFormat (the same
 * message syntax Apple String Catalogs and .NET localize with), rendered by
 * intl-messageformat.
 *
 * This is the FIRST slice of a full multi-language catalog, not a throwaway:
 * today there is exactly one locale (`en`) and `resolveLocale()` is hardcoded
 * to it. Adding a language later = drop in `<locale>.json` with the same keys
 * and make resolveLocale() return it — NOTHING at the call sites changes.
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

type Catalog = Record<string, string>;

// One catalog today; the map is what a new locale plugs into (see resolveLocale).
const CATALOGS: Record<string, Catalog> = { en };

/**
 * The active UI locale. Hardcoded to "en" until the multi-language catalog
 * lands; this function is the single seam that future work swaps (for
 * `navigator.language` / the proxy-reported locale). Isolating it here is what
 * keeps every call site stable when more locales arrive.
 */
export function resolveLocale(): string {
  return "en";
}

function catalog(): Catalog {
  return CATALOGS[resolveLocale()] ?? CATALOGS.en;
}

function format(key: string, values: Record<string, unknown>): string {
  const message = catalog()[key];
  if (message === undefined) return key; // fail visibly, never throw over a UI string
  return new IntlMessageFormat(message, resolveLocale()).format(values) as string;
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
