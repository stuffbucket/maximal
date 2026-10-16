import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import { Button } from "../../../../shell/src/ui/components/Button";
import { Stack } from "../../../../shell/src/ui/components/Stack";

const meta = {
  title: "Components/Button",
  component: Button,
  args: { children: "Save changes", onClick: fn() },
  argTypes: {
    variant: { control: "inline-radio", options: ["primary", "secondary", "ghost", "destructive"] },
    size: { control: "inline-radio", options: ["md", "sm"] },
  },
} satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = { args: { variant: "primary" } };
export const Secondary: Story = { args: { variant: "secondary" } };
export const Ghost: Story = { args: { variant: "ghost" } };
export const Destructive: Story = { args: { variant: "destructive", children: "Remove" } };
export const Disabled: Story = { args: { variant: "primary", disabled: true } };

export const AllVariants: Story = {
  render: (args) => (
    <Stack proximity="section">
      {(["md", "sm"] as const).map((size) => (
        <Stack key={size} proximity="group" direction="horizontal" align="center" wrap>
          <Button {...args} size={size} variant="primary">Primary</Button>
          <Button {...args} size={size} variant="secondary">Secondary</Button>
          <Button {...args} size={size} variant="ghost">Ghost</Button>
          <Button {...args} size={size} variant="destructive">Destructive</Button>
          <Button {...args} size={size} variant="primary" disabled>Disabled</Button>
        </Stack>
      ))}
    </Stack>
  ),
};
