import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import type { AppEntry } from "../../../../shell/src/proxy/client";
import { AppsPanel } from "../../../../shell/src/ui/features/apps/AppsPanel";
import { HarnessRow } from "../../../../shell/src/ui/features/apps/HarnessRow";
import type { MockApiParameters } from "../mock/fetch-mock";

const claudeCode: AppEntry = {
  id: "claude-code",
  name: "Claude Code",
  kind: "config",
  enabled: true,
  status: "ready",
  installs: [
    {
      path: "/Users/you/.local/bin/claude",
      version: "2.1.195",
      source: "local-bin",
    },
  ],
  install: null,
  conflict: null,
};

const notFound: AppEntry = {
  ...claudeCode,
  enabled: false,
  status: "not-installed",
  installs: [],
  install: {
    method: "curl",
    command: "curl -fsSL https://claude.ai/install.sh | sh",
    automatic: null,
  },
};

const otherMaximalConflict: AppEntry = {
  ...claudeCode,
  enabled: false,
  conflict: "other-maximal-config",
};

const comingSoon = (id: AppEntry["id"], name: string): AppEntry => ({
  id,
  name,
  kind: "coming-soon",
  enabled: false,
  status: "coming-soon",
  installs: [],
  install: null,
  conflict: null,
});

const meta = {
  title: "Settings/Apps",
  component: HarnessRow,
  decorators: [
    (Story, context) =>
      context.name.startsWith("Panel") ? (
        <div className="sb-pane">
          <Story />
        </div>
      ) : (
        <div className="sb-pane">
          <table className="table harnesses__table">
            <tbody>
              <Story />
            </tbody>
          </table>
        </div>
      ),
  ],
  args: {
    app: claudeCode,
    onToggle: fn(async () => ({ ok: true })),
  },
} satisfies Meta<typeof HarnessRow>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Installed, routed, and ready end to end. The name opens the detected app. */
export const InstalledWorking: Story = {};

/** Installed and available, with routing turned off. */
export const InstalledOff: Story = {
  args: { app: { ...claudeCode, enabled: false } },
};

/** A working Codex CLI row. */
export const CodexWorking: Story = {
  args: {
    app: {
      ...claudeCode,
      id: "codex",
      name: "Codex CLI",
      installs: [
        {
          kind: "cli",
          path: "/Users/you/.local/bin/codex",
          version: "1.0.0",
          source: "local-bin",
        },
      ],
    },
  },
};

/** Missing from this host. Connect replaces the switch. */
export const NotFound: Story = {
  args: { app: notFound },
};

/** A stale conflict never blocks setup instructions while the app is missing. */
export const NotFoundWithConflict: Story = {
  args: { app: { ...notFound, conflict: "other-maximal-config" } },
};

/** Connect on a missing app offers its official setup instructions. */
export const MissingConnectDialog: Story = {
  args: { app: notFound },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: /connect/i }),
    );
  },
};

/** A setting owned by another tool stays untouched and explains safe cleanup. */
export const NeedsAttention: Story = {
  args: {
    app: { ...claudeCode, enabled: false, conflict: "foreign-base-url" },
  },
};

/** Another Maximal profile can be deliberately connected after confirmation. */
export const OtherMaximalConnectDialog: Story = {
  args: { app: otherMaximalConflict },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: /connect/i }),
    );
  },
};

// ---- Claude Desktop restart dialog (after an applied change) ---------------

const claudeDesktop: AppEntry = {
  ...claudeCode,
  id: "claude-desktop",
  name: "Claude Desktop",
  installs: [
    {
      path: "/Applications/Claude.app",
      version: null,
      source: "unknown",
      kind: "desktop",
    },
  ],
};

const RESTART_TITLE = "Restart Claude Desktop";
const restartDialog = (): HTMLElement =>
  within(document.body).getByRole("dialog", { name: RESTART_TITLE });

/** Flip the row's switch; the server applies it, so the dialog opens. */
const toggleDesktop = (enabledBefore: boolean): Story => ({
  args: {
    app: { ...claudeDesktop, enabled: enabledBefore },
    onToggle: fn(async () => ({ ok: true, applied: true })),
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("checkbox"));
    await waitFor(() => expect(restartDialog()).toBeVisible());
  },
  parameters: { docs: { story: { inline: false, height: "360px" } } },
});

/** After enabling: restart guidance plus the sign-in recovery note. */
export const DesktopRestartAfterEnable = toggleDesktop(false);
/** After disabling: the same guidance, no sign-in note. */
export const DesktopRestartAfterDisable = toggleDesktop(true);

/** Connecting over another Maximal profile's setting is an enable too. */
export const DesktopRestartAfterConnect: Story = {
  args: {
    app: { ...claudeDesktop, enabled: false, conflict: "other-maximal-config" },
    onToggle: fn(async () => ({ ok: true, applied: true })),
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: /connect/i }),
    );
    const connect = await within(document.body).findByRole("dialog");
    await userEvent.click(
      within(connect).getByRole("button", { name: /connect/i }),
    );
    await waitFor(() => expect(restartDialog()).toBeVisible());
  },
  parameters: { docs: { story: { inline: false, height: "360px" } } },
};

const takeOverApp: AppEntry = {
  ...claudeDesktop,
  enabled: false,
  conflict: "foreign-gateway-profile",
};

const openTakeOver = async (canvasElement: HTMLElement): Promise<HTMLElement> => {
  await userEvent.click(
    within(canvasElement).getByRole("button", { name: /connect/i }),
  );
  return within(document.body).findByRole("dialog", { name: "Connect Claude" });
};

/** Another gateway is applied: Maximal left it alone. Close is the default
 *  (right, first focus); Take over is the explicit alternative on the left. */
export const DesktopTakeOverDialog: Story = {
  args: {
    app: takeOverApp,
    onToggle: fn(async () => ({ ok: true, applied: true })),
  },
  play: async ({ args, canvasElement }) => {
    const dialog = await openTakeOver(canvasElement);
    await expect(
      within(dialog)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Take over", "Close"]);
    await expect(within(dialog).getByRole("button", { name: "Close" })).toHaveFocus();
    await expect(dialog).not.toHaveTextContent("Cowork");
    await expect(args.onToggle).not.toHaveBeenCalled();
  },
  parameters: { docs: { story: { inline: false, height: "360px" } } },
};

/** Take over is an enable that switches away from the other gateway. */
export const DesktopTakeOverApplied: Story = {
  args: {
    app: takeOverApp,
    onToggle: fn(async () => ({ ok: true, applied: true })),
  },
  play: async ({ args, canvasElement }) => {
    const dialog = await openTakeOver(canvasElement);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Take over" }),
    );
    await waitFor(() => expect(restartDialog()).toBeVisible());
    await expect(args.onToggle).toHaveBeenCalledWith(true, {
      overrideForeignGateway: true,
    });
  },
  parameters: { docs: { story: { inline: false, height: "360px" } } },
};

/** A refused enable says nothing about restarting: the row offers Connect. */
export const DesktopEnableRefused: Story = {
  args: {
    app: { ...claudeDesktop, enabled: false },
    onToggle: fn(async () => ({ ok: true, applied: false })),
  },
  play: async ({ args, canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("checkbox"));
    await waitFor(() => expect(args.onToggle).toHaveBeenCalledWith(true));
    await expect(
      within(document.body).queryByRole("dialog", { name: RESTART_TITLE }),
    ).toBeNull();
  },
};

/** ChatGPT is represented without implying that routing works yet. */
export const ChatGptComingSoon: Story = {
  args: { app: comingSoon("chatgpt", "ChatGPT") },
};

/** Pi is represented without implying that routing works yet. */
export const PiComingSoon: Story = {
  args: { app: comingSoon("pi", "Pi") },
};

/** Copilot CLI is represented without implying that routing works yet. */
export const CopilotCliComingSoon: Story = {
  args: { app: comingSoon("copilot-cli", "Copilot CLI") },
};

const panel = (mockApi: MockApiParameters): Story => ({
  render: () => <AppsPanel />,
  parameters: { mockApi },
});

export const PanelLoaded: Story = {
  ...panel({ scenario: "signed-in" }),
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText("Pi");
    await expect(
      [...canvasElement.querySelectorAll(".harness-row__name")].map((element) =>
        element.textContent?.trim(),
      ),
    ).toEqual([
      "ChatGPT",
      "Claude Code",
      "Claude Desktop (Cowork, Code)",
      "Codex CLI",
      "Copilot CLI",
      "Pi",
    ]);
  },
};
export const PanelNotFound = panel({ scenario: "claude-code-missing" });
export const PanelNeedsAttention = panel({ scenario: "apps-conflict" });
export const PanelLoading = panel({
  overrides: { "/settings/api/apps": "hang" },
});
export const PanelLoadError = panel({
  overrides: {
    "/settings/api/apps": {
      status: 500,
      body: { error: { message: "Couldn't read app settings." } },
    },
  },
});
/** Maximal not answering, after automatic retries. */
export const PanelUnreachable = panel({
  overrides: { "/settings/api/apps": "offline" },
});
