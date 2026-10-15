import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import type { AppEntry } from "../../../../shell/src/proxy/client";
import { AppCard } from "../../../../shell/src/ui/features/apps/AppCard";
import { AppsPanel } from "../../../../shell/src/ui/features/apps/AppsPanel";
import type { MockApiParameters } from "../mock/fetch-mock";

const claudeCode: AppEntry = {
  id: "claude-code",
  name: "Claude Code",
  kind: "config",
  enabled: true,
  status: "ready",
  installs: [{ path: "/Users/you/.local/bin/claude", version: "2.1.195", source: "local-bin" }],
  install: null,
  conflict: null,
};

const meta = {
  title: "Settings/Apps",
  component: AppCard,
  decorators: [(Story) => <div className="sb-pane"><Story /></div>],
  args: {
    app: claudeCode,
    onToggle: fn(async () => ({ ok: true })),
    onRescan: fn(async () => {}),
  },
} satisfies Meta<typeof AppCard>;
export default meta;
type Story = StoryObj<typeof meta>;

// ---- AppCard, one state per story (props only, no backend) ----------------

export const CardOn: Story = {};
export const CardOff: Story = { args: { app: { ...claudeCode, enabled: false } } };
export const CardMultipleInstalls: Story = {
  args: {
    app: {
      ...claudeCode,
      installs: [
        ...claudeCode.installs,
        { path: "/opt/homebrew/bin/claude", version: "2.1.180", source: "homebrew" },
      ],
    },
  },
};
export const CardNotInstalled: Story = {
  args: {
    app: {
      ...claudeCode,
      enabled: false,
      status: "not-installed",
      installs: [],
      install: { method: "curl", command: "curl -fsSL https://claude.ai/install.sh | sh" },
    },
  },
};
export const CardConflictBaseUrl: Story = {
  args: { app: { ...claudeCode, enabled: false, conflict: "foreign-base-url" } },
};
export const CardConflictApiKeyHelper: Story = {
  args: { app: { ...claudeCode, enabled: false, conflict: "foreign-api-key-helper" } },
};
export const CardToggleFails: Story = {
  args: { onToggle: fn(async () => ({ ok: false, error: "Couldn't write ~/.claude/settings.json (permission denied)." })) },
};
export const CardClaudeDesktop: Story = {
  args: { app: { ...claudeCode, id: "claude-desktop", name: "Claude Desktop", enabled: false, installs: [] } },
};
export const CardComingSoon: Story = {
  args: {
    app: { ...claudeCode, id: "copilot-cli", name: "Copilot CLI", kind: "coming-soon", status: "coming-soon", enabled: false, installs: [] },
  },
};

// ---- the whole panel against the mock sidecar ------------------------------

const panel = (mockApi: MockApiParameters): Story => ({
  render: () => <AppsPanel />,
  parameters: { mockApi },
});

export const Panel = panel({ scenario: "signed-in" });
export const PanelClaudeCodeMissing = panel({ scenario: "claude-code-missing" });
export const PanelConflict = panel({ scenario: "apps-conflict" });
export const PanelLoading = panel({ overrides: { "/settings/api/apps": "hang" } });
export const PanelLoadError = panel({
  overrides: { "/settings/api/apps": { status: 500, body: { error: { message: "Couldn't read app settings." } } } },
});
/** Maximal not answering, after ~5s of automatic retries. */
export const PanelUnreachable = panel({ overrides: { "/settings/api/apps": "offline" } });
