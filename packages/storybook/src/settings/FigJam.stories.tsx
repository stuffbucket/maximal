import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { ConnectorsPanel } from "../../../../shell/src/ui/features/connectors/ConnectorsPanel";
import type { MockApiParameters } from "../mock/fetch-mock";

/**
 * The FigJam integration in Settings → Integrations → Connectors: an
 * `extension`-kind plugin, listed beside Work IQ. Its modal has the status
 * block (state, detail, facts, buttons) and its settings, but no endpoint,
 * apps or tool permissions. Each scenario lists Work IQ (ready) and FigJam
 * in the stage named; dialogs also open from `#connectors/figjam`.
 */
const meta = {
  title: "Settings/FigJam",
  component: ConnectorsPanel,
  decorators: [(Story) => <div className="sb-pane"><Story /></div>],
} satisfies Meta<typeof ConnectorsPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

const list = (mockApi: MockApiParameters): Story => ({ parameters: { mockApi } });
const dialog = (mockApi: MockApiParameters, play?: Story["play"]): Story => ({
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
export const ListReady: Story = {
  ...list({ scenario: "figjam-ready" }),
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole("button", { name: "Work IQ" });
    await expect(
      [...canvasElement.querySelectorAll(".connector-row__name")].map(
        (element) => element.textContent?.trim(),
      ),
    ).toEqual(["FigJam", "Work IQ"]);
  },
};
/** A panel is waiting for approval: the row still reads ready (the tray and toast carry the ask). */
export const ListPairing = list({ scenario: "figjam-pairing" });
/** Bridge port taken: "Error". */
export const ListPortInUse = list({ scenario: "figjam-port-in-use" });

// ---- the detail dialog ---------------------------------------------------------

/** Off: the switch says so; the bridge port is still editable under Settings. */
export const DialogOff = dialog({ scenario: "figjam-off" });
/** "Set up the Figma plugin" as the primary button. */
export const DialogNeedsSetup = dialog({ scenario: "figjam-needs-setup" });
/** Manifest path and the Figma import instructions. */
export const DialogReady = dialog({ scenario: "figjam-ready" });
/** Two boards connected. */
export const DialogConnected = dialog({ scenario: "figjam-connected" });
/** A waiting panel: a notice with "Review request" instead of inline Approve / Deny. */
export const DialogPairing = dialog({ scenario: "figjam-pairing" }, async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await canvas.findByRole("button", { name: "Review request" });
  await expect(canvas.queryByRole("button", { name: /^Approve/ })).toBeNull();
  await expect(canvas.queryByRole("button", { name: /^Deny/ })).toBeNull();
});
/** Two panels waiting: the notice says how many more follow the first. */
export const DialogPairingTwo = dialog({ scenario: "figjam-pairing-two" }, async ({ canvasElement }) => {
  await within(canvasElement).findByText("1 more request is waiting.");
});
/** Port 4150 is already in use: the error with "Try again". */
export const DialogPortInUse = dialog({ scenario: "figjam-port-in-use" });

/** Setting up the Figma plugin moves the dialog from needs-setup to ready. */
export const DialogSetUp = dialog({ scenario: "figjam-needs-setup" }, async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole("button", { name: "Set up the Figma plugin" }));
  await canvas.findByText("Ready for FigJam panels");
});

/** Opens the waiting panel's question. The native dialog stays inside the story root, in the top layer. */
const reviewRequest = async (canvasElement: HTMLElement): Promise<ReturnType<typeof within>> => {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole("button", { name: "Review request" }));
  return within(await canvas.findByRole("dialog", { name: /Let the FigJam panel/ }));
};

/** The question: panel, board and profile named; focus starts on Not now, never on Approve. */
export const RequestDialog = dialog({ scenario: "figjam-pairing" }, async ({ canvasElement }) => {
  const ask = await reviewRequest(canvasElement);
  await ask.findByText("Roadmap");
  await ask.findByText("Alex Morgan");
  await expect(ask.getByRole("button", { name: "Not now" })).toHaveFocus();
  await expect(ask.getByRole("button", { name: "Deny" })).toBeEnabled();
  await expect(ask.getByRole("button", { name: "Approve" })).toBeEnabled();
});

/** Escape is Not now: nothing is answered, the request still waits, focus returns to Review. */
export const RequestEscapeIsNotNow = dialog({ scenario: "figjam-pairing" }, async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await reviewRequest(canvasElement);
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(canvas.queryByRole("dialog", { name: /Let the FigJam panel/ })).toBeNull());
  await expect(canvas.getByRole("button", { name: "Review request" })).toHaveFocus();
});

/** Approving the waiting panel connects it. */
export const DialogApprove = dialog({ scenario: "figjam-pairing" }, async ({ canvasElement }) => {
  const ask = await reviewRequest(canvasElement);
  await userEvent.click(ask.getByRole("button", { name: "Approve" }));
  await within(canvasElement).findByText("Connected to 2 FigJam boards");
});

/** Deny refuses an unexpected panel for good; nothing connects. */
export const DialogDeny = dialog({ scenario: "figjam-pairing" }, async ({ canvasElement }) => {
  const ask = await reviewRequest(canvasElement);
  await userEvent.click(ask.getByRole("button", { name: "Deny" }));
  await within(canvasElement).findByText("Ready for FigJam panels");
});

/** With two waiting, answering the first opens the second in the same dialog. */
export const RequestNext = dialog({ scenario: "figjam-pairing-two" }, async ({ canvasElement }) => {
  const ask = await reviewRequest(canvasElement);
  await userEvent.click(ask.getByRole("button", { name: "Approve" }));
  await within(canvasElement).findByRole("dialog", { name: /Sprint retro/ });
});

/** The extension dialog has no MCP endpoint, apps or tool permissions. */
export const DialogHasNoConnectorSections: Story = {
  ...dialog({ scenario: "figjam-ready" }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Ready for FigJam panels");
    await expect(canvas.queryByText("Connect")).toBeNull();
    await expect(canvas.queryByRole("button", { name: /Copy/ })).toBeNull();
  },
};
