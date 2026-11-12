import type { Meta, StoryObj } from "@storybook/react-vite";

import type { ScenarioId } from "../../../../scripts/ui-harness-fixtures";
import { WindowFrame } from "../WindowFrame";
import { scenarioIds, scenarioLabel } from "../mock/fetch-mock";

/**
 * The real, shipped Rules surface: the fourth view of the unified window,
 * next to Settings, Dashboard and Sessions, in an iframe at its Tauri default
 * size against the mock sidecar. Pick any Rules scenario from the controls;
 * theme and locale follow the toolbar.
 *
 * Built by scripts/prepare-ui.ts. `pnpm dev` restages on save; switch
 * stories (or reload) to pick up a change.
 */
interface Args {
  scenario: ScenarioId;
  /** Backend paths that answer 500, for error states. */
  fail?: Array<string>;
}

const meta = {
  title: "Windows/Rules",
  parameters: { layout: "centered", a11y: { test: "off" } },
  args: { scenario: "budget-limits" },
  argTypes: {
    scenario: {
      control: "select",
      options: scenarioIds,
      labels: Object.fromEntries(scenarioIds.map((id) => [id, scenarioLabel(id)])),
    },
  },
  render: (args, { globals }) => (
    <WindowFrame
      surface="settings"
      section="rules"
      scenario={args.scenario}
      fail={args.fail}
      theme={globals.theme as string}
      locale={globals.locale as string}
    />
  ),
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<Args>;

const at = (scenario: ScenarioId, fail?: Array<string>): Story => ({ args: { scenario, fail } });

/** Rules that are fine, nearly spent and spent, with a week of activity. */
export const LimitsAndActivity = at("budget-limits");
/** Enforcement off: limits kept, none refuses. */
export const EnforcementOff = at("budget-off");
/** Spend and a provider allowance, no limits yet. */
export const NoLimitsYet = at("budget-no-limits");
/** First run: nothing configured, nothing spent. */
export const FirstRun = at("budget-empty");
/** Amounts in AI credits. */
export const InCredits = at("budget-credits");
/** No usage database: every amount reads zero. */
export const NoUsageDatabase = at("budget-storage-off");
/** The status can't load: a banner at the top with the one remedy. */
export const LoadError = at("budget-limits", ["/settings/api/budget"]);
/** The spend behind the chart can't load: the error sits in Activity. */
export const ActivityLoadError = at("budget-limits", ["/settings/api/budget/activity"]);
