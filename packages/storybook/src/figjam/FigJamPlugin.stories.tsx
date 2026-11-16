import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  FigJamPluginFrame,
  type FigJamPanelState,
} from "./FigJamPluginFrame";

interface Args {
  state: FigJamPanelState;
}

const meta = {
  title: "FigJam/Plugin Panel",
  parameters: { layout: "centered", a11y: { test: "off" } },
  tags: ["asset", "journey", "funnel-figjam"],
  args: { state: "ready" },
  argTypes: {
    state: {
      control: "select",
      options: ["ready", "selection", "conversation", "settings", "pairing"],
    },
  },
  render: (args, { globals }) => (
    <FigJamPluginFrame state={args.state} theme={globals.theme as string} />
  ),
} satisfies Meta<Args>;

export default meta;
type Story = StoryObj<Args>;

/** The installed panel is connected to Maximal and ready for a board request. */
export const Ready: Story = {};

/** Selection context from the FigJam sandbox is attached to the next request. */
export const SelectionContext: Story = { args: { state: "selection" } };

/** A complete prompt and response using deterministic model fixture data. */
export const Conversation: Story = { args: { state: "conversation" } };

/** Local model, effort, bridge, and Figma token settings. */
export const Settings: Story = { args: { state: "settings" } };

/** Claude Code control is waiting for approval in Maximal. */
export const BridgeApproval: Story = { args: { state: "pairing" } };
