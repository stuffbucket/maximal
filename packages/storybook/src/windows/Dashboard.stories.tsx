import type { Meta, StoryObj } from "@storybook/react-vite";

import type { ScenarioId } from "../../../../scripts/ui-harness-fixtures";
import { WindowFrame } from "../WindowFrame";
import { scenarioIds, scenarioLabel } from "../mock/fetch-mock";

/**
 * The real, shipped Dashboard window in an iframe at its Tauri default size,
 * reading /usage and /token-usage from the mock sidecar.
 * Follows the OS appearance (Theme: System) or the toolbar's pin, from the
 * same generated theme tokens as Settings.
 */
interface Args {
  scenario: ScenarioId;
}

const meta = {
  title: "Windows/Dashboard",
  parameters: { layout: "centered", a11y: { test: "off" } },
  args: { scenario: "signed-in" },
  argTypes: {
    scenario: {
      control: "select",
      options: scenarioIds,
      labels: Object.fromEntries(scenarioIds.map((id) => [id, scenarioLabel(id)])),
    },
  },
  render: (args, { globals }) => (
    <WindowFrame
      surface="dashboard"
      scenario={args.scenario}
      theme={globals.theme as string}
      locale={globals.locale as string}
    />
  ),
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<Args>;

/** Quotas (one metered, two unlimited) + a day of mixed-model traffic, 3 pages of events. */
export const BusyDay: Story = {};
/** No quota data and no requests yet. */
export const Empty: Story = { args: { scenario: "fresh-install" } };
/** Meter colors mean something: one quota running low (78%), one nearly out (95%). */
export const QuotaNearlyOut: Story = { args: { scenario: "quota-nearly-out" } };
/** The window sat open past the reset: no stale percentage, "Period ended", and a refetch. */
export const QuotaPeriodEnded: Story = { args: { scenario: "quota-period-ended" } };
