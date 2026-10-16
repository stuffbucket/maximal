import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import type { ApiKeyEntry } from "../../../../src/lib/config/settings-types";
import { AddConnection } from "../../../../shell/src/ui/features/api-clients/AddConnection";
import { AdvancedSection } from "../../../../shell/src/ui/features/api-clients/AdvancedSection";
import { ApiClients } from "../../../../shell/src/ui/features/api-clients/ApiClients";
import { ConnectionCard } from "../../../../shell/src/ui/features/api-clients/ConnectionCard";
import type { MockApiParameters } from "../mock/fetch-mock";

const laptop: ApiKeyEntry = {
  id: "key_1",
  label: "Laptop",
  key: "mxl_live_abcd1234efgh",
  enabled: true,
  created_at: "2025-06-14T15:06:40.000Z",
};

const meta = {
  title: "Settings/API clients",
  component: ConnectionCard,
  decorators: [(Story) => <div className="sb-pane"><Story /></div>],
  args: {
    entry: laptop,
    update: fn(async () => ({ ok: true })),
    onDelete: fn(),
  },
} satisfies Meta<typeof ConnectionCard>;
export default meta;
type Story = StoryObj<typeof meta>;

// ---- pieces ------------------------------------------------------------------

export const Connection: Story = {};
export const ConnectionDisabled: Story = { args: { entry: { ...laptop, label: "CI", enabled: false } } };
export const ConnectionLongName: Story = {
  args: { entry: { ...laptop, label: "Build agent on the shared Mac mini in the studio closet" } },
};

export const AddConnectionForm: Story = {
  render: () => <AddConnection create={fn(async () => ({ ok: true }))} onDone={fn()} />,
};
export const AddConnectionFails: Story = {
  render: () => (
    <AddConnection create={fn(async () => ({ ok: false, error: "A connection with that name already exists." }))} onDone={fn()} />
  ),
};

export const Advanced: Story = {
  render: () => <AdvancedSection enforcing={false} setEnforce={fn(async () => ({ ok: true }))} />,
};
export const AdvancedEnforcing: Story = {
  render: () => <AdvancedSection enforcing setEnforce={fn(async () => ({ ok: true }))} />,
};

// ---- the whole section against the mock sidecar ----------------------------

const section = (mockApi: MockApiParameters): Story => ({
  render: () => <ApiClients />,
  parameters: { mockApi },
});

export const Section = section({ scenario: "signed-in" });
export const SectionEmpty = section({ scenario: "fresh-install" });
export const SectionLoadError = section({
  overrides: { "/settings/api/api-keys": { status: 500, body: { error: { message: "Couldn't read config.json." } } } },
});
/** Maximal not answering, after ~5s of automatic retries. */
export const SectionUnreachable = section({ overrides: { "/settings/api/api-keys": "offline" } });
