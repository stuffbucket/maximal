import type { ScenarioId } from "../../../scripts/ui-harness-fixtures";

export type SettingsSection =
  | "account"
  | "apps"
  | "connectors"
  | "endpoint"
  | "api-clients"
  | "models"
  | "logs"
  | "diagnostics";

export const SETTINGS_SECTIONS: Array<SettingsSection> = [
  "account",
  "apps",
  "connectors",
  "endpoint",
  "api-clients",
  "models",
  "logs",
  "diagnostics",
];

interface WindowFrameProps {
  surface: "settings" | "dashboard";
  scenario: ScenarioId;
  /** Settings only: which sidebar section to open (the app routes on the hash). */
  section?: SettingsSection;
  /** A section's own sub-page, e.g. a connector id under "connectors". */
  page?: string;
  theme: string;
  locale: string;
  /** Backend paths to answer with a 500, to show error states. */
  fail?: Array<string>;
}

/**
 * The real built window (staged by scripts/prepare-ui.ts) in an iframe at
 * its Tauri default size, backed by the mock sidecar for `scenario`.
 * Keyed on the URL so every arg change boots a fresh page + fresh mock.
 */
export function WindowFrame({ surface, scenario, section, page, theme, locale, fail = [] }: WindowFrameProps): JSX.Element {
  const query = new URLSearchParams([
    ["scenario", scenario],
    ["theme", theme],
    ["locale", locale],
    ...fail.map((path) => ["fail", path]),
  ]).toString();
  const hash = section ? `#${section}${page ? `/${page}` : ""}` : "";
  const src = `ui/${surface}/index.html?${query}${hash}`;
  return (
    <iframe
      key={src}
      className={`sb-window sb-window--${surface}`}
      src={src}
      title={`${surface} window — ${scenario}`}
    />
  );
}
