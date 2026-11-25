import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import { Button } from "../../../../shell/src/ui/components/Button";
import { Callout } from "../../../../shell/src/ui/components/Callout";
import { EmptyState } from "../../../../shell/src/ui/components/EmptyState";

/**
 * The two shapes for "nothing normal to show here": a Callout banner across
 * the section when something failed or needs saying, and an EmptyState where
 * a list will be. Neither is ever a bare line of colored text.
 */
const meta = {
  title: "Components/Feedback",
  component: Callout,
  decorators: [(Story) => <div className="sb-pane"><Story /></div>],
  args: {
    tone: "error",
    title: "Couldn't load your apps",
    children: "Maximal didn't answer in time. Check that it's running, then try again.",
  },
  argTypes: {
    tone: { control: "inline-radio", options: ["error", "notice"] },
    action: { table: { disable: true } },
  },
} satisfies Meta<typeof Callout>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ErrorWithRetry: Story = {
  args: { action: <Button size="sm" onClick={fn()}>Try again</Button> },
};
export const ErrorNoTitle: Story = { args: { title: undefined } };
export const Notice: Story = {
  args: {
    tone: "notice",
    title: "Using your existing setup",
    children: "Claude Code already has its own Work IQ server, so Maximal doesn't add one.",
  },
};

export const Empty: Story = {
  render: () => (
    <EmptyState title="No connectors yet" action={<Button size="sm">Check again</Button>}>
      <p>
        Turn one on in Settings → Integrations → Connectors. It shows up here to share with your
        apps.
      </p>
    </EmptyState>
  ),
};
export const EmptyCompact: Story = {
  render: () => (
    <EmptyState title="No connections yet" compact>
      <p>Add a connection for each app you want to recognize.</p>
    </EmptyState>
  ),
};
