import type { Meta, StoryObj } from "@storybook/react-vite";

import type { ScenarioId } from "../../../../scripts/ui-harness-fixtures";
import { WindowFrame } from "../WindowFrame";
import { scenarioIds, scenarioLabel } from "../mock/fetch-mock";

interface Args {
  scenario: ScenarioId;
  /** Backend paths to answer with a 500 (see WindowFrame). */
  fail?: Array<string>;
}

const meta = {
  title: "Windows/Sessions",
  parameters: { layout: "centered", a11y: { test: "off" } },
  args: { scenario: "live-sessions" },
  argTypes: {
    scenario: {
      control: "select",
      options: scenarioIds,
      labels: Object.fromEntries(
        scenarioIds.map((id) => [id, scenarioLabel(id)]),
      ),
    },
  },
  render: (args, { globals }) => (
    <WindowFrame
      surface="dashboard"
      observabilityView="sessions"
      scenario={args.scenario}
      theme={globals.theme as string}
      locale={globals.locale as string}
      fail={args.fail}
    />
  ),
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<Args>;

/** Streaming, warm, cooling, and cold sessions with live rate and context. */
export const LiveSessions: Story = {};
/** No requests have reached Maximal yet. */
export const Empty: Story = { args: { scenario: "fresh-install" } };
/** The sessions endpoint failed while the rest of the observability UI remains available. */
export const Unavailable: Story = {
  args: { fail: ["/token-usage/sessions"] },
};
