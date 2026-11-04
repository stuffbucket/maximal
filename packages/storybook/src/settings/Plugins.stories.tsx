import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ComponentProps, useState } from "react";
import { fn, userEvent, within } from "storybook/test";

import { workiqView } from "../../../../scripts/ui-harness-fixtures";
import { PluginCard } from "../../../../shell/src/ui/features/plugins/PluginCard";
import { PluginsPanel } from "../../../../shell/src/ui/features/plugins/PluginsPanel";
import type { MockApiParameters } from "../mock/fetch-mock";

type OnUpdate = ComponentProps<typeof PluginCard>["onUpdate"];

/** Applies a successful save to the card's plugin, like the panel does with
 *  the server's reply, so the card stories stay interactive. */
function LiveCard(args: ComponentProps<typeof PluginCard>): JSX.Element {
  const [plugin, setPlugin] = useState(args.plugin);
  const onUpdate: OnUpdate = async (change) => {
    const result = await args.onUpdate(change);
    if (result.ok) {
      setPlugin({
        ...plugin,
        enabled: change.enabled ?? plugin.enabled,
        clients: plugin.clients.map((c) => ({
          ...c,
          selected: change.clients ? change.clients.includes(c.id) : c.selected,
        })),
      });
    }
    return result;
  };
  return <PluginCard {...args} plugin={plugin} onUpdate={onUpdate} />;
}

const meta = {
  title: "Settings/Plugins",
  component: PluginCard,
  decorators: [(Story) => <div className="sb-pane"><Story /></div>],
  render: (args) => <LiveCard key={JSON.stringify(args.plugin)} {...args} />,
  args: {
    plugin: workiqView({ stage: "ready" }),
    onUpdate: fn<OnUpdate>(async () => ({ ok: true })),
    onAction: fn(async () => ({ ok: true })),
    onRefresh: fn(async () => {}),
  },
} satisfies Meta<typeof PluginCard>;
export default meta;
type Story = StoryObj<typeof meta>;

// ---- PluginCard, one state per story (props only, no backend) -----------------

/** Off: just the name, description and switch; the twirldown is disabled. */
export const CardOff: Story = { args: { plugin: workiqView() } };
/** On, with Microsoft's terms still to accept (the action confirms first). */
export const CardTermsNeeded: Story = { args: { plugin: workiqView({ stage: "terms-needed" }) } };
export const CardTermsConfirm: Story = {
  args: { plugin: workiqView({ stage: "terms-needed" }) },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Accept terms" }));
  },
};
export const CardSignInNeeded: Story = { args: { plugin: workiqView({ stage: "signin-needed" }) } };
/** The plugin is waiting on the browser; it offers Cancel. */
export const CardWorking: Story = { args: { plugin: workiqView({ stage: "working" }) } };
/** Ready: facts, Sign out (destructive, confirms), connections, endpoint, tools folded. */
export const CardReady: Story = {};
export const CardReadyToolsOpen: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByText(/\d+ tools/));
  },
};
export const CardSignOutConfirm: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Sign out" }));
  },
};
/** Signed in, but the organization hasn't approved the plugin. */
export const CardError: Story = { args: { plugin: workiqView({ stage: "error" }) } };
/** It didn't start: the error says why, and nothing else can be done yet. */
export const CardFailed: Story = {
  args: {
    plugin: workiqView({ failed: "plugins.workiq.config.endpoint: Invalid URL. Expected an https address." }),
  },
};
/** Claude Code is chosen but isn't set up in Apps: a warning stands where its box would be. */
export const CardClientUnavailable: Story = {
  args: { plugin: workiqView({ stage: "ready", claudeCodeUnavailable: true }) },
  play: async ({ canvasElement }) => {
    within(canvasElement).getByRole("img", { name: /unavailable/ }).focus();
  },
};
export const CardClientUnticked: Story = {
  args: { plugin: workiqView({ stage: "ready", selected: false }) },
};
/** A change in flight: the controls hold the new state and lock until it saves. */
export const CardSaving: Story = {
  args: { onUpdate: fn<OnUpdate>(() => new Promise(() => {})) },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByLabelText("Add Work IQ to Claude Code"));
  },
};
export const CardSaveFails: Story = {
  args: {
    onUpdate: fn<OnUpdate>(async () => ({
      ok: false,
      problem: {
        title: "Maximal isn't allowed to change a file",
        detail: "It doesn't have permission to write ~/.claude.json. Check the file's permissions, then try again.",
        remedy: "retry",
        technical: "HTTP 500: EACCES: permission denied, open '/Users/you/.claude.json'",
      },
    })),
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByLabelText("Add Work IQ to Claude Code"));
  },
};
export const CardActionFails: Story = {
  args: {
    plugin: workiqView({ stage: "signin-needed" }),
    onAction: fn(async () => ({
      ok: false,
      problem: {
        title: "Maximal couldn't save that change",
        detail: "Work IQ isn't running, so it can't do that. Switch it on, then try again.",
        remedy: "retry" as const,
        technical: "HTTP 409: plugin is not running",
      },
    })),
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Sign in" }));
  },
};

// ---- the whole panel against the mock sidecar ------------------------------

const panel = (mockApi: MockApiParameters): Story => ({
  render: () => <PluginsPanel />,
  parameters: { mockApi },
});

/** Nothing on yet (the default). */
export const PanelOff = panel({ scenario: "plugins-off" });
export const PanelTermsNeeded = panel({ scenario: "plugins-terms-needed" });
export const PanelSignInNeeded = panel({ scenario: "plugins-signin-needed" });
export const PanelWorking = panel({ scenario: "plugins-working" });
export const PanelReady = panel({ scenario: "plugins-ready" });
export const PanelError = panel({ scenario: "plugins-error" });
/** Invalid settings: it didn't start. */
export const PanelFailed = panel({ scenario: "plugins-failed" });
export const PanelClaudeCodeOff = panel({ scenario: "plugins-claude-code-off" });
/** Walk it end to end: switch on, accept terms, sign in (it finishes by itself). */
export const PanelSetupFlow = panel({ scenario: "plugins-off", latencyMs: 250 });
export const PanelEmpty = panel({ overrides: { "/settings/api/plugins": { status: 200, body: { plugins: [] } } } });
export const PanelLoading = panel({ overrides: { "/settings/api/plugins": "hang" } });
/** Maximal not answering, after ~5s of automatic retries. */
export const PanelUnreachable = panel({ overrides: { "/settings/api/plugins": "offline" } });
