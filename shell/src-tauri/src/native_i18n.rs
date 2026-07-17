//! Native-string i18n for the Tauri shell — the OS-drawn chrome the webview
//! catalog can't reach: the tray menu, notifications, the Settings/Dashboard
//! window titles, and the native Quit dialog.
//!
//! **Single source of truth.** This module does not carry its own strings. It
//! `include_str!`s the SAME `shell/src/i18n/*.json` catalogs the webview renders
//! with (see shell/src/i18n/index.ts) and reads the `native-*` keys out of them.
//! Add or translate a native string in those JSON files and both sides move
//! together; tests/i18n-catalog-parity.test.ts pins every `native-*` key
//! referenced here back to the catalog so the two can't drift.
//!
//! **Deliberately not ICU.** The webview uses a full ICU MessageFormat runtime
//! (`intl-messageformat`); we do not pull that into Rust. The native strings
//! need only named-placeholder substitution (`{version}`, `{latest}`, `{url}`,
//! `{message}`, `{reason}`) — no `plural`/`select`. The one OS-conditional term
//! (`app-container`: menu bar vs system tray) is handled the way it always was:
//! the caller picks the `-macos` / `-other` key via `cfg!(target_os)`, so no
//! runtime `select` is needed here either.
//!
//! **Resolution mirrors the JS side** exactly: a message resolves through the
//! `<region> → <language> → en` fallback chain (`es-MX → es → en`), and a key
//! missing from every catalog renders as the key itself (fails visibly, never
//! panics over a UI string).

use std::collections::HashMap;
use std::sync::OnceLock;

/// The base catalog and the rest of the shipped locales, embedded from the
/// single-source JSON. `en` is fully populated; the others are sparse overrides
/// resolved through the fallback chain, EXCEPT `es`, which is a full language
/// base (es-MX/es-ES fall back to it). Keep this list in lockstep with
/// `CATALOGS` in shell/src/i18n/index.ts.
const EN: &str = include_str!("../../src/i18n/en.json");
const EN_GB: &str = include_str!("../../src/i18n/en-GB.json");
const ES: &str = include_str!("../../src/i18n/es.json");
const ES_MX: &str = include_str!("../../src/i18n/es-MX.json");
const ES_ES: &str = include_str!("../../src/i18n/es-ES.json");
const ZH: &str = include_str!("../../src/i18n/zh.json");
const FR: &str = include_str!("../../src/i18n/fr.json");
const DE: &str = include_str!("../../src/i18n/de.json");
const RU: &str = include_str!("../../src/i18n/ru.json");
const JA: &str = include_str!("../../src/i18n/ja.json");
const IT: &str = include_str!("../../src/i18n/it.json");
const PT: &str = include_str!("../../src/i18n/pt.json");

/// The locale tags this build ships, in declared order — the same set the
/// picker offers. Used both for the best-fit matcher and to validate an
/// incoming `set_locale` tag. Keep in lockstep with `CATALOGS` in
/// shell/src/i18n/index.ts.
pub const AVAILABLE: &[&str] = &[
    "en", "en-GB", "es", "es-MX", "es-ES", "zh", "fr", "de", "ru", "ja", "it",
    "pt",
];

fn raw(tag: &str) -> &'static str {
    match tag {
        "en" => EN,
        "en-GB" => EN_GB,
        "es" => ES,
        "es-MX" => ES_MX,
        "es-ES" => ES_ES,
        "zh" => ZH,
        "fr" => FR,
        "de" => DE,
        "ru" => RU,
        "ja" => JA,
        "it" => IT,
        "pt" => PT,
        _ => "{}",
    }
}

/// Lazily-parsed catalogs, keyed by locale tag. Parsed once on first use; a
/// malformed catalog (which the parity test would already have caught in CI)
/// degrades to empty rather than panicking the shell at startup.
fn catalogs() -> &'static HashMap<&'static str, HashMap<String, String>> {
    static CATALOGS: OnceLock<HashMap<&'static str, HashMap<String, String>>> =
        OnceLock::new();
    CATALOGS.get_or_init(|| {
        AVAILABLE
            .iter()
            .map(|&tag| {
                let parsed = serde_json::from_str::<HashMap<String, String>>(raw(tag))
                    .unwrap_or_default();
                (tag, parsed)
            })
            .collect()
    })
}

/// The language subtag of a BCP-47 tag (`es-MX` → `es`).
fn language_of(tag: &str) -> &str {
    tag.split('-').next().unwrap_or(tag)
}

/// Look a key up through a locale's resource-fallback chain: region catalog →
/// language catalog → base (`en`). Returns None only when no catalog carries it.
fn lookup(key: &str, locale: &str) -> Option<&'static str> {
    let cats = catalogs();
    let lang = language_of(locale);
    cats.get(locale)
        .and_then(|c| c.get(key))
        .or_else(|| cats.get(lang).and_then(|c| c.get(key)))
        .or_else(|| cats.get("en").and_then(|c| c.get(key)))
        .map(|s| s.as_str())
}

/// Substitute `{name}` placeholders with their values. This is the whole of our
/// "format" support — no select/plural, matching what the native strings need.
fn interpolate(template: &str, args: &[(&str, &str)]) -> String {
    let mut out = template.to_string();
    for (name, value) in args {
        out = out.replace(&format!("{{{name}}}"), value);
    }
    out
}

/// Resolve a native string for `locale`, substituting any `{placeholder}` args.
/// A key absent from every catalog renders as the key itself (visible failure),
/// mirroring the JS `t()` contract.
pub fn t(locale: &str, key: &str, args: &[(&str, &str)]) -> String {
    match lookup(key, locale) {
        Some(template) => interpolate(template, args),
        None => key.to_string(),
    }
}

/// Convenience for the (common) no-argument case.
pub fn tr(locale: &str, key: &str) -> String {
    t(locale, key, &[])
}

/// Resolve the active native locale. Resolution order mirrors the webview's
/// `resolveLocale()`:
///   (a) an explicit persisted override (the picker) if we ship it;
///   (b) a best-fit of the OS locale (`os_locale`) — full tag, then language;
///   (c) `"en"`.
///
/// `os_locale` is the system UI locale (from `sys_locale::get_locale()`), used
/// only as the fallback for strings that fire before any webview — and thus any
/// picker choice — exists (e.g. the first-launch "Maximal is running" banner).
pub fn resolve_locale(persisted: Option<&str>, os_locale: Option<&str>) -> String {
    if let Some(tag) = persisted {
        if AVAILABLE.contains(&tag) {
            return tag.to_string();
        }
    }
    if let Some(raw) = os_locale {
        if let Some(hit) = best_fit(raw) {
            return hit.to_string();
        }
    }
    "en".to_string()
}

/// Best-fit a single BCP-47 tag against `AVAILABLE`: exact match first, then the
/// first available locale sharing its language subtag. Returns None on no match.
fn best_fit(raw: &str) -> Option<&'static str> {
    if let Some(&exact) = AVAILABLE.iter().find(|&&t| t == raw) {
        return Some(exact);
    }
    let lang = language_of(raw);
    AVAILABLE.iter().copied().find(|&t| language_of(t) == lang)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_catalogs_parse_and_cover_english() {
        // en is the base; every native key we render must exist in it.
        let en = &catalogs()["en"];
        assert!(en.contains_key("native-quit-title"));
        assert_eq!(en["native-quit-title"], "Quit Maximal?");
    }

    #[test]
    fn every_available_catalog_parses_non_empty() {
        // Guards the include_str!/raw() wiring: a full language base added to
        // AVAILABLE but missing its embed (or with malformed JSON) would show up
        // here as an empty map instead of silently resolving everything to en at
        // runtime. Sparse regional overrides (es-MX is literally `{}`, es-ES /
        // en-GB carry only a few keys) legitimately may be empty, so only the
        // bases — which must carry the whole catalog incl. native keys — are
        // asserted.
        for &tag in AVAILABLE {
            if tag.contains('-') {
                continue;
            }
            let cat = &catalogs()[tag];
            assert!(!cat.is_empty(), "catalog for {tag} parsed empty");
            assert!(
                cat.contains_key("native-quit-title"),
                "{tag} base is missing native keys"
            );
            // A mis-wired raw() that returned EN for a new tag would still pass
            // the checks above; assert the non-English bases actually differ so
            // the embed is proven distinct, not accidentally aliased to en.
            if tag != "en" {
                assert_ne!(
                    tr(tag, "native-quit-title"),
                    "Quit Maximal?",
                    "{tag} base looks aliased to en"
                );
            }
        }
    }

    #[test]
    fn falls_back_region_to_language_to_en() {
        // es-MX carries no native overrides → resolves to the es language base.
        assert_eq!(tr("es-MX", "native-quit-title"), "¿Salir de Maximal?");
        // A key only in en resolves there from any locale.
        assert_eq!(tr("es", "native-tooltip-idle"), "maximal");
    }

    #[test]
    fn missing_key_renders_itself() {
        assert_eq!(tr("en", "native-does-not-exist"), "native-does-not-exist");
    }

    #[test]
    fn interpolates_named_placeholders() {
        assert_eq!(
            t(
                "en",
                "native-window-settings-title-versioned",
                &[("version", "0.5.0")]
            ),
            "Maximal — Settings · v0.5.0"
        );
        assert_eq!(
            t("es", "native-notify-update-body", &[("url", "https://x")]),
            "Actualiza en https://x"
        );
    }

    #[test]
    fn resolve_prefers_override_then_os_then_en() {
        assert_eq!(resolve_locale(Some("es-ES"), Some("en-US")), "es-ES");
        // Unknown override is ignored; OS locale best-fits by language.
        assert_eq!(resolve_locale(Some("fr-FR"), Some("es-419")), "es");
        // An OS locale for a language we don't ship falls through to en.
        assert_eq!(resolve_locale(None, Some("ko-KR")), "en");
        assert_eq!(resolve_locale(None, None), "en");
    }
}
