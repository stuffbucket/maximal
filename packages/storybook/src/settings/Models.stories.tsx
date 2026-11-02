import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";

import { SCENARIOS } from "../../../../scripts/ui-harness-fixtures";
import { Models } from "../../../../shell/src/ui/features/models/Models";
import type { MockApiParameters } from "../mock/fetch-mock";

/** The Models section reads /settings/api/models; every story is a backend state. */
const meta = {
  title: "Settings/Models",
  component: Models,
  decorators: [(Story) => <div className="sb-pane"><Story /></div>],
} satisfies Meta<typeof Models>;
export default meta;
type Story = StoryObj<typeof meta>;

const state = (mockApi: MockApiParameters): Story => ({ parameters: { mockApi } });

export const Loaded = state({ scenario: "signed-in" });
export const NotLoadedYet = state({ scenario: "signed-out" });
export const Loading = state({ overrides: { "/settings/api/models": "hang" } });
export const LoadError = state({
  overrides: { "/settings/api/models": { status: 500, body: { error: { message: "Model cache file is unreadable." } } } },
});
/** Maximal not answering, after ~5s of automatic retries. */
export const Unreachable = state({ overrides: { "/settings/api/models": "offline" } });
/** Refresh against GitHub Copilot while signed out: send them to sign in. */
export const RefreshNotSignedIn: Story = {
  parameters: {
    mockApi: {
      scenario: "signed-in",
      overrides: { "/settings/api/models/refresh": { status: 401, body: { error: { message: "Bad credentials" } } } },
    },
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Refresh now" }));
  },
};
/** Refresh takes a beat so the in-progress state is visible. */
export const SlowRefresh = state({ scenario: "signed-in", latencyMs: 1500 });

const signedInModels = SCENARIOS["signed-in"].models;
const modelsReply = (claudeCodeAuto: typeof signedInModels.claude_code_auto) => ({
  status: 200,
  body: { ...signedInModels, claude_code_auto: claudeCodeAuto },
});

export const GptFallback = state({
  scenario: "signed-in",
  overrides: {
    "/settings/api/models": modelsReply({
      ...signedInModels.claude_code_auto,
      fast: {
        configured: null,
        effective: "gpt-5.6-mini",
        source: "automatic",
        status: "ready",
        reason: "small-gpt",
      },
      capable: {
        configured: null,
        effective: "gpt-5.6",
        source: "automatic",
        status: "ready",
        reason: "gpt",
      },
    }),
  },
});

export const UnavailableOverride = state({
  scenario: "signed-in",
  overrides: {
    "/settings/api/models": modelsReply({
      ...signedInModels.claude_code_auto,
      fast: {
        configured: "gpt-retired",
        effective: null,
        source: "maximal-override",
        status: "unavailable",
        reason: "override-unavailable",
      },
    }),
  },
});

const unresolved = {
  configured: null,
  effective: null,
  source: "none" as const,
  status: "unresolved" as const,
  reason: "no-match" as const,
};

export const Unresolved = state({
  scenario: "signed-in",
  overrides: {
    "/settings/api/models": modelsReply({
      applied: true,
      options: [],
      fast: unresolved,
      capable: unresolved,
    }),
  },
});

export const SlowSave: Story = {
  parameters: { mockApi: { scenario: "signed-in", latencyMs: 1500 } },
  play: async ({ canvasElement }) => {
    await userEvent.selectOptions(
      within(canvasElement).getByLabelText("Fast and background work"),
      "gpt-5.6-mini",
    );
  },
};

export const SaveFailure: Story = {
  parameters: {
    mockApi: {
      scenario: "signed-in",
      overrides: {
        "/settings/api/models/claude-code-auto": {
          status: 500,
          body: { error: { message: "Could not write config" } },
        },
      },
    },
  },
  play: async ({ canvasElement }) => {
    await userEvent.selectOptions(
      within(canvasElement).getByLabelText("Fast and background work"),
      "gpt-5.6-mini",
    );
  },
};
