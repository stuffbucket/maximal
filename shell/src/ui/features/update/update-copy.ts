import { t } from "../../../i18n";

import type { UpdateOffer, UpdatePhase } from "./update-flow";

export interface UpdateConfirmCopy {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
}

/**
 * What the confirmation says for each hand-off. In place and the download
 * page reuse the native dialogs' wording (the tray asks with them), so both
 * entry points say the same thing.
 * The download page and apt never claim Maximal installs or restarts itself.
 */
export function updateConfirmCopy(offer: UpdateOffer): UpdateConfirmCopy {
  const version = offer.version;
  const title = t("native-update-confirm-title");
  const cancelLabel = t("native-update-confirm-cancel");
  switch (offer.route) {
    case "in-place":
      return {
        title,
        body: t("native-update-confirm-body", { version }),
        confirmLabel: t("native-update-confirm-install"),
        cancelLabel,
      };
    case "download":
      return {
        title,
        body: t("native-update-open-body", { version }),
        confirmLabel: t("native-update-open-action"),
        cancelLabel,
      };
    case "apt":
      return {
        title,
        body: t("update-confirm-apt-body", { version }),
        confirmLabel: t("update-confirm-apt-action"),
        cancelLabel,
      };
  }
}

/**
 * The entry points' names: the title-bar icon's accessible name and tooltip,
 * and the System button's text. While the update downloads they say so.
 */
export function updateButtonLabels(
  offer: UpdateOffer,
  phase: UpdatePhase,
): { icon: string; system: string } {
  if (phase === "downloading") {
    return {
      icon: t("nav-update-downloading"),
      system: t("system-update-downloading"),
    };
  }
  return {
    icon: t("nav-update-icon", { version: offer.version }),
    system: t("nav-update-to", { version: offer.version }),
  };
}
