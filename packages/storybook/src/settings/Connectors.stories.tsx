import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ComponentProps, useState } from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { workiqDetail } from "../../../../scripts/ui-harness-fixtures";
import type { PluginDetailView } from "../../../../src/lib/config/settings-types";
import { ConfigForm } from "../../../../shell/src/ui/features/connectors/ConfigForm";
import { ConnectorsPanel } from "../../../../shell/src/ui/features/connectors/ConnectorsPanel";
import type { MockApiParameters } from "../mock/fetch-mock";

/**
 * Settings → Integrations → Connectors against the mock sidecar: the list
 * stays visible behind each connector's modal detail state. Dialogs also open
 * from the app's `#connectors/<id>` deep link.
 */
const meta = {
  title: "Settings/Connectors",
  component: ConnectorsPanel,
  decorators: [(Story) => <div className="sb-pane"><Story /></div>],
} satisfies Meta<typeof ConnectorsPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

const list = (mockApi: MockApiParameters): Story => ({ parameters: { mockApi } });
/** The dialog is open and its heading has taken first focus; focus moved before that is stolen back. */
const dialogSettled = async (canvas: ReturnType<typeof within>): Promise<void> => {
  await waitFor(() => expect(canvas.getByRole("heading", { name: "Work IQ", level: 3 })).toHaveFocus());
};
const dialog = (mockApi: MockApiParameters, play?: Story["play"]): Story => ({
  args: { initialConnectorId: "workiq" },
  parameters: { mockApi },
  play,
});

// ---- the list ------------------------------------------------------------------

/** Work IQ ready: a tick in the Status column. */
export const List = list({ scenario: "connectors-list" });
/** Off: a muted dot and "Off". */
export const ListOff = list({ scenario: "connectors-off" });
export const ListFailed = list({ scenario: "connectors-detail-failed" });
export const ListNeedsSetup = list({ scenario: "connectors-detail-terms-needed" });
export const ListEmpty = list({ overrides: { "/settings/api/plugins": { status: 200, body: { plugins: [] } } } });
export const ListLoading = list({ overrides: { "/settings/api/plugins": "hang" } });
/** Maximal not answering, after ~5s of automatic retries. */
export const ListUnreachable = list({ overrides: { "/settings/api/plugins": "offline" } });
/** Open a row, then come back: focus returns to the row. */
export const ListOpenAndClose: Story = {
  ...list({ scenario: "connectors-list" }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Work IQ" }));
    await userEvent.click(await canvas.findByRole("button", { name: "Close" }));
    await waitFor(() => expect(canvas.getByRole("button", { name: "Work IQ" })).toHaveFocus());
  },
};

// ---- a connector's detail dialog ------------------------------------------------

/** 14 tools in three groups; one write tool and one other tool blocked (Custom). */
export const DialogReady = dialog({ scenario: "connectors-detail-ready" });
/** A destructive plugin action stacks its confirmation above the detail dialog. */
export const DialogConfirmation = dialog({ scenario: "connectors-detail-ready" }, async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole("button", { name: "Sign out" }));
  await canvas.findByRole("dialog", { name: "Sign out?" });
});
export const DialogTermsNeeded = dialog({ scenario: "connectors-detail-terms-needed" });
/** Signed out: tools from the cached catalog, with when they were last seen. */
export const DialogSignInNeededCached = dialog({ scenario: "connectors-detail-signin-needed-cached" });
export const DialogWorking = dialog({ scenario: "connectors-detail-working" });
export const DialogError = dialog({ scenario: "connectors-detail-error" });
/** Didn't start: unreadable settings file. */
export const DialogFailed = dialog({ scenario: "connectors-detail-failed" });
/** Didn't start: its configuration is invalid; the form is where to fix it. */
export const DialogConfigError = dialog({ scenario: "connectors-detail-config-error" });
/** Saving the invalid endpoint again: the connector's complaint lands on the field. */
export const DialogConfigErrorSaved = dialog({ scenario: "connectors-detail-config-error" }, async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  // Advanced is open: the connector failed, so its config is the suspect.
  const endpoint = await canvas.findByLabelText("Endpoint");
  await userEvent.type(endpoint, "/v2");
  await userEvent.click(canvas.getByRole("button", { name: "Save" }));
  await canvas.findByText(/Invalid URL/);
});
export const DialogClaudeCodeOff = dialog({ scenario: "connectors-claude-code-off" });
/** Claude Code is Blocked: every other app and connection still has its own permission row. */
export const DialogNoAppsSelected = dialog({ scenario: "connectors-no-apps" });
/**
 * App Permissions: every fixed app (Claude Code, Claude Desktop, Codex, Copilot
 * CLI) and every named API connection (Laptop, CI) gets its own Allow / Ask /
 * Block row. Claude Code and Laptop are usable; the others say why they aren't.
 */
export const DialogAppPermissions: Story = {
  ...dialog({ scenario: "connectors-detail-ready" }, async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const expected: Array<[string, RegExp]> = [
      ["Claude Code", /allow/i],
      ["Claude Desktop", /ask/i],
      ["Codex", /block/i],
      ["Copilot CLI", /ask/i],
      ["Laptop", /allow/i],
      ["CI", /block/i],
    ];
    for (const [target, permission] of expected) {
      const group = await canvas.findByRole("radiogroup", { name: new RegExp(`Permission for ${target}$`) });
      await expect(within(group).getByRole("radio", { name: permission })).toBeChecked();
    }
  }),
  tags: ["asset"],
};
/** Named API connections sit below the fixed apps; CI is turned off but keeps its Block policy. */
export const DialogNamedConnections = dialog({ scenario: "connectors-detail-ready" }, async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await canvas.findByText("Laptop");
  await canvas.findByText("CI");
  const ci = await canvas.findByRole("radiogroup", { name: /Permission for CI$/ });
  await expect(within(ci).getByRole("radio", { name: /block/i })).toBeChecked();
});
/** Each row is three-way: Allow, then Ask, then Block, for a fixed app and a named connection. */
export const DialogAppPermissionsTriState = dialog({ scenario: "connectors-detail-ready" }, async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  for (const target of ["Claude Code", "Laptop"]) {
    const group = await canvas.findByRole("radiogroup", { name: new RegExp(`Permission for ${target}$`) });
    for (const permission of [/ask/i, /block/i, /allow/i]) {
      // The control is read-only while a save is in flight; wait it out.
      await waitFor(() => expect(group).not.toHaveAttribute("aria-busy"));
      await userEvent.click(within(group).getByRole("radio", { name: permission }));
      await waitFor(() => expect(within(group).getByRole("radio", { name: permission })).toBeChecked());
    }
    await waitFor(() => expect(group).not.toHaveAttribute("aria-busy"));
  }
});
/**
 * A slow save keeps keyboard focus on the radio group: the options stay
 * focusable (read-only, aria-busy) instead of being disabled, the status
 * live region is already mounted and fills in, and arrows work again after.
 */
export const DialogAppPermissionsKeyboard = dialog(
  { scenario: "connectors-detail-ready", latencyMs: 300 },
  async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const group = await canvas.findByRole("radiogroup", { name: /Permission for Claude Code$/ });
    await dialogSettled(canvas);
    const status = canvasElement.querySelector(".connector-detail__saving");
    await expect(status).toBeInTheDocument();
    await expect(status).toBeEmptyDOMElement();

    within(group).getByRole("radio", { name: /allow/i }).focus();
    await userEvent.keyboard("{ArrowRight}");
    const ask = within(group).getByRole("radio", { name: /ask/i });
    await expect(ask).toBeChecked();
    await expect(ask).toHaveFocus();
    await expect(ask).toBeEnabled();
    await expect(group).toHaveAttribute("aria-busy", "true");
    await expect(group).toHaveAttribute("aria-readonly", "true");
    await expect(status).toHaveTextContent("Saving");

    // Read-only while saving: a second arrow neither moves focus nor saves.
    await userEvent.keyboard("{ArrowRight}");
    await expect(ask).toBeChecked();
    await expect(ask).toHaveFocus();

    await waitFor(() => expect(group).not.toHaveAttribute("aria-busy"));
    await expect(status).toBeEmptyDOMElement();
    await expect(ask).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    const block = within(group).getByRole("radio", { name: /block/i });
    await waitFor(() => expect(block).toBeChecked());
    await expect(block).toHaveFocus();
  },
);
/** Hovering the info control beside an unavailable app opens a card with the reason; clicking it keeps it open. */
export const DialogUnavailableInfo = dialog({ scenario: "connectors-detail-ready" }, async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const info = await canvas.findByRole("button", { name: "Why Codex is unavailable" });
  // At least a 24px target.
  const box = info.getBoundingClientRect();
  await expect(box.width).toBeGreaterThanOrEqual(24);
  await expect(box.height).toBeGreaterThanOrEqual(24);
  // Closed: the card isn't in the DOM at all (no hidden overflow, no stale text).
  await expect(canvas.queryByRole("tooltip")).toBeNull();
  await userEvent.hover(info);
  const card = await canvas.findByRole("tooltip");
  // The dialog fades in; visibility is only meaningful once it has.
  await waitFor(() => expect(card).toBeVisible());
  await expect(card).toHaveTextContent("Maximal doesn't add connectors to Codex yet.");
  await expect(info).toHaveAccessibleDescription("Maximal doesn't add connectors to Codex yet.");
  // The click that follows a hover must not close it.
  await userEvent.click(info);
  await expect(canvas.getByRole("tooltip")).toBeVisible();
  await expect(info).toHaveAccessibleDescription("Maximal doesn't add connectors to Codex yet.");
  // The card stays inside the dialog's scrolling body.
  const body = canvasElement.querySelector(".connector-detail__body");
  const bounds = body?.getBoundingClientRect();
  const cardBox = card.getBoundingClientRect();
  await expect(bounds).toBeDefined();
  await expect(cardBox.left).toBeGreaterThanOrEqual((bounds?.left ?? 0) - 1);
  await expect(cardBox.right).toBeLessThanOrEqual((bounds?.right ?? 0) + 1);
});
/** Keyboard focus opens the card; the first Escape closes only the card, the next is left for the dialog. */
export const DialogUnavailableConnectionInfo = dialog({ scenario: "connectors-detail-ready" }, async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const info = await canvas.findByRole("button", { name: "Why CI is unavailable" });
  await dialogSettled(canvas);
  info.focus();
  const card = await canvas.findByRole("tooltip");
  await waitFor(() => expect(card).toBeVisible());
  await expect(card).toHaveTextContent("This connection is turned off.");
  const escape = (): KeyboardEvent => {
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    info.dispatchEvent(event);
    return event;
  };
  // Open: Escape is consumed (that also suppresses the native dialog's cancel).
  await expect(escape().defaultPrevented).toBe(true);
  await waitFor(() => expect(canvas.queryByRole("tooltip")).toBeNull());
  await expect(info).toHaveFocus();
  // Closed: Escape passes through so the dialog can dismiss.
  await expect(escape().defaultPrevented).toBe(false);
});
/** The Write/delete group's menu open: Custom is checked, not choosable. */
export const DialogGroupMenu = dialog({ scenario: "connectors-detail-ready" }, async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole("button", { name: /Permission for Write\/delete tools/ }));
});
/** Ask's inputs and full schema open. */
export const DialogToolOpen = dialog({ scenario: "connectors-detail-ready" }, async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole("button", { name: /question, fileUrls, conversationId/ }));
  const schemas = canvas.getAllByRole("button", { name: "Full schema" });
  await userEvent.click(schemas[schemas.length - 3]);
});
/** Blocking a tool fails: the control snaps back and the banner says why. */
export const DialogPermissionSaveFails = dialog(
  {
    scenario: "connectors-detail-ready",
    overrides: {
      "/settings/api/plugins/workiq/tool-permissions": {
        status: 500,
        body: { error: { message: "EACCES: permission denied, open '/Users/you/.local/share/copilot-api/plugins/workiq/settings.json'" } },
      },
    },
  },
  async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const group = await canvas.findByRole("radiogroup", { name: "Permission for Retrieve" });
    await userEvent.click(within(group).getByRole("radio", { name: "Blocked" }));
  },
);
export const DialogLoadFails = dialog({
  scenario: "connectors-detail-ready",
  overrides: { "/settings/api/plugins/workiq": "offline" },
});

// ---- the configuration form on its own, every control kind -------------------------

type OnSave = ComponentProps<typeof ConfigForm>["onSave"];

const richSchema: NonNullable<PluginDetailView["configSchema"]> = {
  type: "object",
  properties: {
    endpoint: { type: "string", format: "uri", title: "Endpoint", description: "MCP endpoint (Streamable HTTP).", default: "https://example.com/mcp" },
    label: { type: "string", title: "Label", description: "Shown in your apps' tool lists." },
    verbose: { type: "boolean", title: "Verbose logging", description: "Log every upstream request." },
    timeoutSeconds: { type: "integer", title: "Timeout", description: "Seconds before a tool call gives up.", default: 60 },
    region: { type: "string", enum: ["us", "eu", "apac"], title: "Region" },
    authority: { type: "string", format: "uri", title: "Sign-in authority", "x-maximal-advanced": true },
    extraHeaders: { type: "object", title: "Extra headers", description: "Set in the settings file.", "x-maximal-advanced": true },
  },
  required: ["endpoint"],
};

function LiveForm({ onSave }: { onSave: OnSave }): JSX.Element {
  const [connector, setConnector] = useState<PluginDetailView & { configSchema: typeof richSchema }>({
    ...workiqDetail({ stage: "ready" }),
    configSchema: richSchema,
    config: { endpoint: "https://example.com/mcp", verbose: false, extraHeaders: { "x-team": "docs" } },
  });
  return (
    <ConfigForm
      connector={connector}
      onSave={async (change) => {
        const result = await onSave(change);
        if (result.ok && change.config) setConnector((prev) => ({ ...prev, config: change.config }));
        return result;
      }}
    />
  );
}

export const ConfigFormAllControls: StoryObj<{ onSave: OnSave }> = {
  render: (args) => <LiveForm onSave={args.onSave} />,
  args: { onSave: fn<OnSave>(async () => ({ ok: true })) },
};

export const ConfigFormRejected: StoryObj<{ onSave: OnSave }> = {
  render: (args) => <LiveForm onSave={args.onSave} />,
  args: {
    onSave: fn<OnSave>(async () => ({
      ok: false,
      issues: [
        { path: "config.timeoutSeconds", message: "Too big: expected a number ≤ 600." },
        { path: "config", message: "Pick a region before setting a timeout." },
      ],
    })),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText("Timeout"), "900");
    await userEvent.click(canvas.getByRole("button", { name: "Save" }));
  },
};
