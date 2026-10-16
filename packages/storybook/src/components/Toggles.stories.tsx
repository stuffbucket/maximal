import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { fn } from "storybook/test";

import { Checkbox } from "../../../../shell/src/ui/components/Checkbox";
import { Switch } from "../../../../shell/src/ui/components/Switch";

/** Switch + Checkbox are controlled; these stories hold the state locally. */
const meta = {
  title: "Components/Toggles",
  component: Switch,
  args: { checked: true, label: "Route Claude Code through maximal", onCheckedChange: fn() },
} satisfies Meta<typeof Switch>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SwitchControl: Story = {
  name: "Switch",
  render: function Render(args) {
    const [checked, setChecked] = useState(args.checked);
    return (
      <Switch
        {...args}
        checked={checked}
        onCheckedChange={(next) => {
          setChecked(next);
          args.onCheckedChange(next);
        }}
      />
    );
  },
};

export const SwitchDisabled: Story = { args: { disabled: true } };
export const SwitchHiddenLabel: Story = { args: { hideLabel: true } };

export const CheckboxControl: Story = {
  name: "Checkbox",
  render: function Render(args) {
    const [checked, setChecked] = useState(args.checked);
    return (
      <Checkbox
        label="Require an API key for every request"
        hideLabel={false}
        checked={checked}
        onCheckedChange={(next) => {
          setChecked(next);
          args.onCheckedChange(next);
        }}
      />
    );
  },
};

export const CheckboxDisabled: Story = {
  render: (args) => <Checkbox label="Claude Desktop (turn on its integration first)" hideLabel={false} checked={false} disabled onCheckedChange={args.onCheckedChange} />,
};

/** An "all" box over a partly-checked group shows the mixed state. */
export const CheckboxIndeterminate: Story = {
  render: (args) => (
    <Checkbox label="All apps" hideLabel={false} checked={false} indeterminate onCheckedChange={args.onCheckedChange} />
  ),
};
