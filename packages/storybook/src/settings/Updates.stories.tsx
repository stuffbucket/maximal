import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect } from "react";
import { expect, waitFor } from "storybook/test";

import type { ScenarioId } from "../../../../scripts/ui-harness-fixtures";
import { UpdateConfirmDialog } from "../../../../shell/src/ui/features/update/UpdateConfirmDialog";
import { requestUpdateConfirmation } from "../../../../shell/src/ui/features/update/update-confirm";
import type { UpdateRoute } from "../../../../shell/src/ui/features/update/update-flow";
import { WindowFrame } from "../WindowFrame";

/**
 * The confirmation every Settings update entry point opens: the title bar's
 * icon and System → Version and updates' "Update to X.Y.Z" button. The words
 * follow how this build hands the update off (installs in place, opens the
 * download page, or shows the apt command). Window stories open it from each
 * entry point in the real Settings window.
 */
interface Args {
  route: UpdateRoute;
  version: string;
}

/** Mounts the dialog and asks it about one offer, as the update flow does. */
function Confirmation({ route, version }: Args): JSX.Element {
  useEffect(() => {
    void requestUpdateConfirmation({ route, version, url: "https://mxml.sh/" });
  }, [route, version]);
  return <UpdateConfirmDialog />;
}

const meta = {
  title: "Settings/Updates",
  component: Confirmation,
  args: { route: "in-place", version: "0.4.40" },
  argTypes: {
    route: { control: "inline-radio", options: ["in-place", "download", "apt"] },
  },
  parameters: { docs: { story: { inline: false, height: "320px" } } },
} satisfies Meta<typeof Confirmation>;
export default meta;
type Story = StoryObj<typeof meta>;

// ---- the dialog, one hand-off per story -----------------------------------

/** Windows and macOS apps: install in place, then restart. */
export const InstallInPlace: Story = {};
/** Builds that can't install themselves: the download page opens. */
export const OpenDownloadPage: Story = { args: { route: "download" } };
/** apt installs: Maximal shows the command; it never runs apt. */
export const AptCommand: Story = { args: { route: "apt" } };

// ---- opened from each entry point in the real window ----------------------

type Opener = "title-bar" | "system";

const OPENER_SELECTOR: Record<Opener, string> = {
  "title-bar": '[data-update-action]:not([hidden]) [data-action="open-update"]',
  system: '[data-system-update]:not([hidden]) [data-action="system-update"]',
};

/** The Settings window at System with an update offered; the play function
 *  clicks `opener` inside it once the page has read the update status. */
const fromWindow = (
  opener: Opener,
  scenario: ScenarioId = "update-available",
): Story => ({
  parameters: { layout: "centered", a11y: { test: "off" } },
  render: (_args, { globals }) => (
    <WindowFrame
      surface="settings"
      section="diagnostics"
      scenario={scenario}
      theme={globals.theme as string}
      locale={globals.locale as string}
    />
  ),
  play: async ({ canvasElement }) => {
    const frame = canvasElement.querySelector("iframe");
    if (!frame) throw new Error("The Settings window iframe is missing");
    const button = await waitFor(
      () => {
        const found = frame.contentDocument?.querySelector<HTMLButtonElement>(
          OPENER_SELECTOR[opener],
        );
        if (!found) throw new Error(`Waiting for the ${opener} update button`);
        return found;
      },
      { timeout: 15_000 },
    );
    button.click();
    await waitFor(
      () =>
        expect(frame.contentDocument?.querySelector("dialog[open]")).not.toBeNull(),
      { timeout: 5_000 },
    );
  },
});

export const FromTitleBar = fromWindow("title-bar");
export const FromSystem = fromWindow("system");
export const FromSystemApt = fromWindow("system", "update-available-apt");
