import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ComponentProps, useState } from "react";
import { fn, userEvent, within } from "storybook/test";

import type { McpEndpointEntry } from "../../../../shell/src/proxy/client";
import { McpEndpointCard } from "../../../../shell/src/ui/features/mcp/McpEndpointCard";
import { McpPanel } from "../../../../shell/src/ui/features/mcp/McpPanel";
import type { MockApiParameters } from "../mock/fetch-mock";

type OnToggle = ComponentProps<typeof McpEndpointCard>["onToggle"];

const workiq: McpEndpointEntry = {
  id: "workiq",
  label: "Work IQ",
  enabled: true,
  clients: ["claude-code"],
  offered: [
    { id: "claude-code", name: "Claude Code", available: true, configured: true },
    { id: "claude-desktop", name: "Claude Desktop", available: false, configured: false },
  ],
};

/** Both apps' Maximal integrations on, nothing chosen yet. */
const bothAvailable: McpEndpointEntry = {
  ...workiq,
  enabled: false,
  clients: [],
  offered: workiq.offered.map((o) => ({ ...o, available: true, configured: false })),
};

/** Tick "All apps" so the save-time states show without a manual click. */
const tickAll: Story["play"] = async ({ canvasElement }) => {
  await userEvent.click(within(canvasElement).getByLabelText("All apps"));
};

/** Applies a successful save to the card's endpoint, like the panel does
 *  with the server's reply, so the card stories stay interactive. */
function LiveCard(args: ComponentProps<typeof McpEndpointCard>): JSX.Element {
  const [endpoint, setEndpoint] = useState(args.endpoint);
  const onToggle: OnToggle = async (enabled, clients = endpoint.clients) => {
    const result = await args.onToggle(enabled, clients);
    if (result.ok) {
      const skipped = new Set(result.skipped?.map((s) => s.client));
      setEndpoint({
        ...endpoint,
        enabled,
        clients,
        offered: endpoint.offered.map((o) => ({
          ...o,
          configured: enabled && o.available && clients.includes(o.id) && !skipped.has(o.id),
        })),
      });
    }
    return result;
  };
  return <McpEndpointCard {...args} endpoint={endpoint} onToggle={onToggle} />;
}

const meta = {
  title: "Settings/MCP servers",
  component: McpEndpointCard,
  decorators: [(Story) => <div className="sb-pane"><Story /></div>],
  render: (args) => <LiveCard key={JSON.stringify(args.endpoint)} {...args} />,
  args: {
    endpoint: workiq,
    onToggle: fn<OnToggle>(async () => ({ ok: true, skipped: [] })),
    onRefresh: fn(async () => {}),
    onRemove: fn(async () => ({ ok: true, removedFrom: [] })),
    onAcceptWorkIqEula: fn(async () => ({ ok: true })),
    onSignInWorkIq: fn(async (_useBrowserSignIn: boolean) => ({ ok: true })),
    onCancelWorkIqSignIn: fn(async () => {}),
  },
} satisfies Meta<typeof McpEndpointCard>;
export default meta;
type Story = StoryObj<typeof meta>;

// ---- McpEndpointCard ---------------------------------------------------------

/** On, added to Claude Code; Claude Desktop's integration is off so it can't be offered. */
export const CardOn: Story = {};
/** Off: closed, twirldown disabled. The app choice is kept for when it's switched on. */
export const CardOff: Story = { args: { endpoint: { ...workiq, enabled: false } } };
/** Switching it on opens the card to show the apps. */
export const CardTurningOn: Story = {
  args: { endpoint: { ...workiq, enabled: false } },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByLabelText("Off"));
  },
};
/** On, folded away with the twirldown. */
export const CardOnCollapsed: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: /apps for/ }));
  },
};
export const CardOnBothApps: Story = {
  args: {
    endpoint: {
      ...bothAvailable,
      enabled: true,
      clients: ["claude-code", "claude-desktop"],
      offered: bothAvailable.offered.map((o) => ({ ...o, configured: true })),
    },
  },
};
/** Some apps chosen: "All apps" shows the mixed state. */
export const CardPartlyChosen: Story = {
  args: {
    endpoint: {
      ...bothAvailable,
      enabled: true,
      clients: ["claude-code"],
      offered: bothAvailable.offered.map((o) => ({ ...o, configured: o.id === "claude-code" })),
    },
  },
};
/** Claude Desktop is chosen but its Maximal integration is off: a warning
 *  stands where its box would be (tooltip shown open). The name links to Apps. */
export const CardAppIntegrationOff: Story = {
  args: { endpoint: { ...workiq, clients: ["claude-code", "claude-desktop"] } },
  play: async ({ canvasElement }) => {
    within(canvasElement).getByRole("img", { name: /unavailable/ }).focus();
  },
};
export const CardNoAppsAvailable: Story = {
  args: {
    endpoint: {
      ...workiq,
      enabled: false,
      clients: [],
      offered: workiq.offered.map((o) => ({ ...o, available: false, configured: false })),
    },
  },
};
/** A change in flight: controls hold the new state and lock until it saves. */
export const CardSaving: Story = {
  args: { endpoint: { ...bothAvailable, enabled: true }, onToggle: fn<OnToggle>(() => new Promise(() => {})) },
  play: tickAll,
};
export const CardKeptExistingEntry: Story = {
  name: "Card · app already had one",
  args: {
    endpoint: { ...bothAvailable, enabled: true },
    onToggle: fn<OnToggle>(async () => ({ ok: true, skipped: [{ client: "claude-desktop" as const, name: "Claude Desktop" }] })),
  },
  play: tickAll,
};
export const CardSaveFails: Story = {
  args: {
    endpoint: { ...bothAvailable, enabled: true },
    onToggle: fn<OnToggle>(async () => ({
      ok: false,
      problem: {
        title: "Maximal isn't allowed to change a file",
        detail: "It doesn't have permission to write ~/Library/Application Support/Claude/claude_desktop_config.json. Check the file's permissions, then try again.",
        remedy: "retry",
        technical: "HTTP 500: EACCES: permission denied, open '/Users/you/Library/Application Support/Claude/claude_desktop_config.json'",
      },
    })),
  },
  play: tickAll,
};

/** Remove asks first, naming the apps it comes out of. */
export const CardRemoveConfirm: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Remove Work IQ" }));
  },
};

// ---- the whole panel against the mock sidecar ------------------------------

const panel = (mockApi: MockApiParameters): Story => ({
  render: () => <McpPanel />,
  parameters: { mockApi },
});

export const Panel = panel({ scenario: "signed-in" });
export const PanelEmpty = panel({ scenario: "fresh-install" });
export const PanelLoading = panel({ overrides: { "/settings/api/mcp": "hang" } });
/** Maximal restarting the broker by itself: a quiet line, nothing to do. */
export const PanelBrokerRecovering = panel({ scenario: "mcp-recovering" });
/** Retries paused after repeated crashes: offer a restart. */
export const PanelBrokerStuck = panel({ scenario: "mcp-stuck" });
/** Can't run at all: explain, no button. */
export const PanelBrokerMissing = panel({ scenario: "mcp-not-installed" });
/** Windows wouldn't contain the servers, so none started: explain, offer a restart. */
export const PanelContainmentUnavailable = panel({ scenario: "mcp-containment-unavailable" });
/** Windows: a long server path wraps, and Claude Code says to turn it on in Apps. */
export const PanelWindows = panel({ scenario: "mcp-windows" });
/** Nothing added yet; Work IQ is installed, so it's offered to add. */
export const PanelServerFound = panel({ scenario: "mcp-found" });
/** Nothing added yet; Work IQ isn't installed: copy the install command; the card notices the install. */
export const PanelServerNotInstalled = panel({ scenario: "mcp-catalog-missing" });
/** Maximal not answering, after ~5s of automatic retries. */
export const PanelUnreachable = panel({ overrides: { "/settings/api/mcp": "offline" } });
