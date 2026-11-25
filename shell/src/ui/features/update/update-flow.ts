import type { UpdateStatusResponse } from "../../../../../src/lib/config/settings-types";
import type { InstallUpdateOutcome } from "../../../tauri/install-update-outcome";

/**
 * How this build hands an update off once the person agrees:
 * - `in-place`: the shell downloads, verifies and installs it, then restarts
 *   (the Windows and macOS apps).
 * - `download`: the system browser opens the download page.
 * - `apt`: Maximal can't run apt, so Settings shows the command to copy.
 */
export type UpdateRoute = "in-place" | "download" | "apt";

export interface UpdateOffer {
  version: string;
  url: string;
  route: UpdateRoute;
}

/**
 * Where the update flow is: `idle`, waiting on the confirmation dialog
 * (`confirming`), or downloading/installing after the person said yes
 * (`downloading`). Every entry point reads the same phase.
 */
export type UpdatePhase = "idle" | "confirming" | "downloading";

/**
 * The update to offer, or null when there is nothing to offer: no newer
 * release, checks disabled, or the version couldn't be resolved. The title
 * bar, the System button and the System status row all read this, so they
 * always agree.
 */
export function updateOffer(
  status: UpdateStatusResponse | null,
  installsInPlace: boolean,
): UpdateOffer | null {
  if (!status?.enabled || !status.update_available || !status.latest) {
    return null;
  }
  const route: UpdateRoute = status.update_command
    ? "apt"
    : installsInPlace
      ? "in-place"
      : "download";
  return { version: status.latest, url: status.url, route };
}

export interface UpdateFlowDeps {
  /** Ask the person; resolves true only on the dialog's confirm action. */
  confirm: (offer: UpdateOffer) => Promise<boolean>;
  /** The shell's in-place install of the version the person confirmed.
   *  `onDownloading` fires once the download starts. */
  installInPlace: (
    version: string,
    onDownloading: () => void,
  ) => Promise<InstallUpdateOutcome>;
  openDownloadPage: (url: string) => void;
  revealAptCommand: () => void;
  onPhaseChange: (phase: UpdatePhase) => void;
}

export interface UpdateFlow {
  readonly phase: UpdatePhase;
  /** Start the update for `offer`. A no-op when nothing is offered or an
   *  update is already being confirmed or installed. */
  start(offer: UpdateOffer | null): Promise<void>;
}

/**
 * The one update flow behind every Settings entry point. It always asks
 * first; only a yes leads to exactly one hand-off. While it asks or installs,
 * further starts are ignored, so no click can begin a second update.
 */
export function createUpdateFlow(deps: UpdateFlowDeps): UpdateFlow {
  let phase: UpdatePhase = "idle";
  const setPhase = (next: UpdatePhase): void => {
    phase = next;
    deps.onPhaseChange(next);
  };

  return {
    get phase(): UpdatePhase {
      return phase;
    },

    async start(offer: UpdateOffer | null): Promise<void> {
      if (!offer || phase !== "idle") return;
      setPhase("confirming");
      let confirmed = false;
      try {
        confirmed = await deps.confirm(offer);
      } catch {
        confirmed = false;
      }
      if (!confirmed) {
        setPhase("idle");
        return;
      }
      switch (offer.route) {
        case "apt":
          setPhase("idle");
          deps.revealAptCommand();
          return;
        case "download":
          setPhase("idle");
          deps.openDownloadPage(offer.url);
          return;
        case "in-place": {
          // The shell skips its own native confirm for this exact version,
          // so the person is asked once. It reports a failure itself.
          let outcome: InstallUpdateOutcome = "failed";
          try {
            outcome = await deps.installInPlace(offer.version, () => {
              setPhase("downloading");
            });
          } finally {
            setPhase("idle");
          }
          if (outcome === "unavailable") deps.openDownloadPage(offer.url);
          return;
        }
      }
    },
  };
}
