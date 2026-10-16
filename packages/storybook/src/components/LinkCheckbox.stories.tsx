import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { fn, within } from "storybook/test";

import { LinkCheckbox } from "../../../../shell/src/ui/components/LinkCheckbox";

/**
 * Checkbox + a label that links to where the target is managed. When the
 * target can't be chosen, a warning replaces the box. Clicking the label
 * always navigates (here, to #apps), never toggles.
 */
const meta = {
  title: "Components/LinkCheckbox",
  component: LinkCheckbox,
  decorators: [(Story) => <div className="sb-pane" style={{ minHeight: "var(--space-8)" }}><Story /></div>],
  args: {
    checked: true,
    label: "Claude Code",
    href: "#apps",
    checkboxLabel: "Add Work IQ to Claude Code",
    onCheckedChange: fn(),
  },
  render: function Render(args) {
    const [checked, setChecked] = useState(args.checked);
    return (
      <LinkCheckbox
        {...args}
        checked={checked}
        onCheckedChange={(next) => {
          setChecked(next);
          args.onCheckedChange(next);
        }}
      />
    );
  },
} satisfies Meta<typeof LinkCheckbox>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Checked: Story = {};
export const Unchecked: Story = { args: { checked: false } };

/** Can't be chosen: a warning stands where the box would be. The label still links. */
export const Unavailable: Story = {
  args: {
    label: "Claude Desktop",
    checkboxLabel: "Add Work IQ to Claude Desktop",
    unavailable:
      "Claude Desktop's Maximal integration is off, so Work IQ isn't in it right now. It comes back when you turn Claude Desktop on in Apps.",
  },
};
/** The warning's tooltip, opened by keyboard focus (Escape dismisses it). */
export const UnavailableTooltipOpen: Story = {
  args: Unavailable.args,
  play: async ({ canvasElement }) => {
    within(canvasElement).getByRole("img", { name: /unavailable/ }).focus();
  },
};
