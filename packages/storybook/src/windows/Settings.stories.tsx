import type { Meta, StoryObj } from "@storybook/react-vite";

import type { ScenarioId } from "../../../../scripts/ui-harness-fixtures";
import { SETTINGS_SECTIONS, type SettingsSection, WindowFrame } from "../WindowFrame";
import { scenarioIds, scenarioLabel } from "../mock/fetch-mock";

/**
 * The real, shipped Settings window — vanilla sections (Account, Endpoint,
 * Logs, Diagnostics) and React islands together — in an iframe at its Tauri
 * default size, against the mock sidecar. Pick any section × scenario from
 * the controls; theme and locale follow the toolbar.
 *
 * Built by scripts/prepare-ui.ts. `pnpm dev` restages on save; switch
 * stories (or reload) to pick up a change.
 */
interface Args {
  section: SettingsSection;
  scenario: ScenarioId;
  /** Backend paths that answer 500, for error states. */
  fail?: Array<string>;
}

const meta = {
  title: "Windows/Settings",
  parameters: { layout: "centered", a11y: { test: "off" } },
  args: { section: "account", scenario: "signed-in" },
  argTypes: {
    section: { control: "select", options: SETTINGS_SECTIONS },
    scenario: {
      control: "select",
      options: scenarioIds,
      labels: Object.fromEntries(scenarioIds.map((id) => [id, scenarioLabel(id)])),
    },
  },
  render: (args, { globals }) => (
    <WindowFrame
      surface="settings"
      section={args.section}
      scenario={args.scenario}
      fail={args.fail}
      theme={globals.theme as string}
      locale={globals.locale as string}
    />
  ),
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<Args>;

const at = (section: SettingsSection, scenario: ScenarioId = "signed-in", fail?: Array<string>): Story => ({
  args: { section, scenario, fail },
});

export const AccountSignedIn = at("account");
export const AccountSignedOut = at("account", "signed-out");
export const AccountSignInPending = at("account", "sign-in-pending");
export const AccountSignInError = at("account", "auth-error");
export const AccountUpstreamRejection = at("account", "upstream-rejection");
export const Apps = at("apps");
export const Endpoint = at("endpoint");
export const ApiClients = at("api-clients");
export const Models = at("models");
export const Logs = at("logs");
export const Diagnostics = at("diagnostics");
export const DiagnosticsUpdateAvailable = at("diagnostics", "update-available");
export const FreshInstall = at("apps", "fresh-install");

// ---- section-level load failures (the banner across the section) ----------
export const AppsLoadError = at("apps", "signed-in", ["/settings/api/apps"]);
export const ApiClientsLoadError = at("api-clients", "signed-in", ["/settings/api/api-keys"]);
export const ModelsLoadError = at("models", "signed-in", ["/settings/api/models"]);
export const DiagnosticsLoadError = at("diagnostics", "signed-in", ["/settings/api/diagnostics"]);

// ---- empty states ----------------------------------------------------------
export const ApiClientsEmpty = at("api-clients", "fresh-install");
