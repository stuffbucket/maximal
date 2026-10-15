/**
 * Classic-script bootstrap injected at the top of the built Settings and
 * Dashboard pages (scripts/prepare-ui.ts). It runs before the app's own
 * module scripts, so by the time main.ts makes its first request the
 * backend is already the mock.
 *
 * Driven by the iframe URL the window stories build (src/WindowFrame.tsx):
 *   ?scenario=<id>   fixture scenario (defaults to the harness default)
 *   &theme=dark|light  pins data-theme; anything else follows the OS
 *   &locale=<tag>    explicit locale override, or none for the browser's
 *   &fail=<path>     answer this backend path with a 500 (repeatable)
 */
import { installMockApi, isScenarioId } from "./fetch-mock";

// Mirrors LOCALE_OVERRIDE_KEY in shell/src/i18n/index.ts.
const LOCALE_OVERRIDE_KEY = "maximal.locale";

const params = new URLSearchParams(window.location.search);
const scenario = params.get("scenario");

const theme = params.get("theme");
if (theme === "dark" || theme === "light") {
  document.documentElement.dataset.theme = theme;
}

try {
  const locale = params.get("locale");
  if (locale) window.localStorage.setItem(LOCALE_OVERRIDE_KEY, locale);
  else window.localStorage.removeItem(LOCALE_OVERRIDE_KEY);
} catch {
  // Storage can be unavailable; the UI falls back to navigator.languages.
}

const overrides = Object.fromEntries(
  params.getAll("fail").map((path) => [
    path,
    { status: 500, body: { error: { message: "Simulated failure from Storybook." } } },
  ]),
);

installMockApi(window, { scenario: isScenarioId(scenario) ? scenario : undefined, overrides });
