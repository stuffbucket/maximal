import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { ConnectorsPanel } from "../../../../shell/src/ui/features/connectors/ConnectorsPanel";
import type { MockApiParameters } from "../mock/fetch-mock";

/**
 * The FigJam integration in Settings → Integrations → Connectors: an
 * `extension`-kind plugin, listed beside Work IQ. Its page has the status
 * block (state, detail, facts, buttons) and its settings, but no endpoint,
 * apps or tool permissions. Each scenario lists Work IQ (ready) and FigJam
 * in the stage named; pages open the way `#connectors/figjam` does.
 */
const meta = {
  title: "Settings/FigJam",
  component: ConnectorsPanel,
  decorators: [(Story) => <div className="sb-pane"><Story /></div>],
} satisfies Meta<typeof ConnectorsPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

const list = (mockApi: MockApiParameters): Story => ({ parameters: { mockApi } });
const page = (mockApi: MockApiParameters, play?: Story["play"]): Story => ({
  args: { initialConnectorId: "figjam" },
  parameters: { mockApi },
  play,
});

// ---- the list ------------------------------------------------------------------

/** Off: a muted dot and "Off". */
export const ListOff = list({ scenario: "figjam-off" });
/** On, the Figma plugin not built yet: "Needs setup". */
export const ListNeedsSetup = list({ scenario: "figjam-needs-setup" });
/** Ready: a tick, same as a ready connector. */
export const ListReady = list({ scenario: "figjam-ready" });
/** A panel is waiting for approval: the row still reads ready (the tray and toast carry the ask). */
export const ListPairing = list({ scenario: "figjam-pairing" });
/** Bridge port taken: "Error". */
export const ListPortInUse = list({ scenario: "figjam-port-in-use" });

// ---- the page ------------------------------------------------------------------

/** Off: the switch says so; the bridge port is still editable under Settings. */
export const PageOff = page({ scenario: "figjam-off" });
/** "Set up the Figma plugin" as the primary button. */
export const PageNeedsSetup = page({ scenario: "figjam-needs-setup" });
/** Manifest path and the Figma import instructions. */
export const PageReady = page({ scenario: "figjam-ready" });
/** Two boards connected. */
export const PageConnected = page({ scenario: "figjam-connected" });
/** Approve and Deny for the waiting panel, beside Rebuild. */
export const PagePairing = page({ scenario: "figjam-pairing" });
/** Port 4150 is already in use: the error with "Try again". */
export const PagePortInUse = page({ scenario: "figjam-port-in-use" });

/** Setting up the Figma plugin moves the page from needs-setup to ready. */
export const PageSetUp = page({ scenario: "figjam-needs-setup" }, async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole("button", { name: "Set up the Figma plugin" }));
  await canvas.findByText("Ready for FigJam panels");
});

/** Approving the waiting panel connects it. */
export const PageApprove = page({ scenario: "figjam-pairing" }, async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole("button", { name: /Approve "Roadmap workshop"/ }));
  await canvas.findByText("Connected to 2 FigJam boards");
});

/** The extension page has no MCP endpoint, apps or tool permissions. */
export const PageHasNoConnectorSections: Story = {
  ...page({ scenario: "figjam-ready" }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Ready for FigJam panels");
    await expect(canvas.queryByText("Connect")).toBeNull();
    await expect(canvas.queryByRole("button", { name: /Copy/ })).toBeNull();
  },
};
