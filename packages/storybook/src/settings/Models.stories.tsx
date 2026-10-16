import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";

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
