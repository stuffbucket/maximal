import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ComponentProps, useState } from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { workiqDetail } from "../../../../scripts/ui-harness-fixtures";
import type { PluginDetailView } from "../../../../src/lib/config/settings-types";
import { ConfigForm } from "../../../../shell/src/ui/features/connectors/ConfigForm";
import { ConnectorsPanel } from "../../../../shell/src/ui/features/connectors/ConnectorsPanel";
import type { MockApiParameters } from "../mock/fetch-mock";

/**
 * Settings → Integrations → Connectors against the mock sidecar: the list,
 * and each connector page state. Pages open the way the app's
 * `#connectors/<id>` link does.
 */
const meta = {
  title: "Settings/Connectors",
  component: ConnectorsPanel,
  decorators: [(Story) => <div className="sb-pane"><Story /></div>],
} satisfies Meta<typeof ConnectorsPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

const list = (mockApi: MockApiParameters): Story => ({ parameters: { mockApi } });
const page = (mockApi: MockApiParameters, play?: Story["play"]): Story => ({
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
export const ListOpenAndBack: Story = {
  ...list({ scenario: "connectors-list" }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Work IQ" }));
    await userEvent.click(await canvas.findByRole("button", { name: /Your connectors/ }));
    await waitFor(() => expect(canvas.getByRole("button", { name: "Work IQ" })).toHaveFocus());
  },
};

// ---- a connector's page ----------------------------------------------------------

/** 14 tools in three groups; one write tool and one other tool blocked (Custom). */
export const PageReady = page({ scenario: "connectors-detail-ready" });
export const PageTermsNeeded = page({ scenario: "connectors-detail-terms-needed" });
/** Signed out: tools from the cached catalog, with when they were last seen. */
export const PageSignInNeededCached = page({ scenario: "connectors-detail-signin-needed-cached" });
export const PageWorking = page({ scenario: "connectors-detail-working" });
export const PageError = page({ scenario: "connectors-detail-error" });
/** Didn't start: unreadable settings file. */
export const PageFailed = page({ scenario: "connectors-detail-failed" });
/** Didn't start: its configuration is invalid; the form is where to fix it. */
export const PageConfigError = page({ scenario: "connectors-detail-config-error" });
/** Saving the invalid endpoint again: the connector's complaint lands on the field. */
export const PageConfigErrorSaved = page({ scenario: "connectors-detail-config-error" }, async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  // Advanced is open: the connector failed, so its config is the suspect.
  const endpoint = await canvas.findByLabelText("Endpoint");
  await userEvent.type(endpoint, "/v2");
  await userEvent.click(canvas.getByRole("button", { name: "Save" }));
  await canvas.findByText(/Invalid URL/);
});
export const PageClaudeCodeOff = page({ scenario: "connectors-claude-code-off" });
/** The Write/delete group's menu open: Custom is checked, not choosable. */
export const PageGroupMenu = page({ scenario: "connectors-detail-ready" }, async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole("button", { name: /Permission for Write\/delete tools/ }));
});
/** Ask's inputs and full schema open. */
export const PageToolOpen = page({ scenario: "connectors-detail-ready" }, async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole("button", { name: /question, fileUrls, conversationId/ }));
  const schemas = canvas.getAllByRole("button", { name: "Full schema" });
  await userEvent.click(schemas[schemas.length - 3]);
});
/** Blocking a tool fails: the control snaps back and the banner says why. */
export const PagePermissionSaveFails = page(
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
export const PageLoadFails = page({
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
