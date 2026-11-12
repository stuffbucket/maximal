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
  /** Backend paths to answer with a 500 (see WindowFrame). */
  fail?: Array<string>;
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
      fail={args.fail}
    />
  ),
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<Args>;

/** Live model-to-session traffic with streaming, warm, and cooling sessions. */
export const LiveTraffic: Story = { args: { scenario: "live-sessions" } };
/** Quotas (one metered, two unlimited) + a day of mixed-model traffic, 3 pages of events. */
export const BusyDay: Story = {};
/** Authentication is required before the Usage Quotas card can show metrics. */
export const SignedOut: Story = { args: { scenario: "signed-out" } };
/** No quota data and no requests yet. */
export const Empty: Story = { args: { scenario: "fresh-install" } };
/** Meter colors mean something: one quota running low (78%), one nearly out (95%). */
export const QuotaNearlyOut: Story = { args: { scenario: "quota-nearly-out" } };
/** The window sat open past the reset: no stale percentage, "Period ended", and a refetch. */
export const QuotaPeriodEnded: Story = { args: { scenario: "quota-period-ended" } };
/**
 * GitHub's usage read keeps failing before any good one: the quota layout in
 * muted ink with placeholders under "Waiting for GitHub usage…", no red error.
 * The Dashboard retries on its own (30 s, 1, 2, then every 5 minutes).
 */
export const UsageUnavailable: Story = { args: { fail: ["/usage"] } };
