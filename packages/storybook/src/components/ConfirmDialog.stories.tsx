import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { fn } from "storybook/test";

import { Button } from "../../../../shell/src/ui/components/Button";
import { ConfirmDialog } from "../../../../shell/src/ui/components/ConfirmDialog";

/**
 * A native modal <dialog> (showModal), so on the Docs page each story runs
 * in its own iframe rather than trapping the whole page.
 */
const meta = {
  title: "Components/ConfirmDialog",
  component: ConfirmDialog,
  args: {
    open: true,
    title: "Remove this connection?",
    body: "Apps using the Laptop key will stop being labeled. You can add it again any time.",
    confirmLabel: "Remove",
    cancelLabel: "Cancel",
    tone: "danger",
    busy: false,
    onConfirm: fn(),
    onCancel: fn(),
  },
  parameters: { docs: { story: { inline: false, height: "320px" } } },
} satisfies Meta<typeof ConfirmDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Danger: Story = {};
export const Default: Story = {
  args: {
    tone: "default",
    title: "Restart Claude Code to finish",
    body: "On Windows, Claude Code reads its settings at launch. Run /exit in each open session, then start it again.",
    confirmLabel: "Turn off",
  },
};
export const Busy: Story = { args: { busy: true } };

/** Opened from a button, the way the app uses it. */
export const Interactive: Story = {
  args: { open: false },
  render: function Render(args) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button variant="destructive" onClick={() => setOpen(true)}>
          Remove connection
        </Button>
        <ConfirmDialog
          {...args}
          open={open}
          onConfirm={() => {
            args.onConfirm();
            setOpen(false);
          }}
          onCancel={() => {
            args.onCancel();
            setOpen(false);
          }}
        />
      </>
    );
  },
};
