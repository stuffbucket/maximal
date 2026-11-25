import type { AppId } from "../../../proxy/client";
import { cx } from "../../components/cx";

const ICON_URLS: Record<AppId, string> = {
  "claude-code": new URL("./icons/claude-code.svg", import.meta.url).href,
  "claude-desktop": new URL("./icons/claude-desktop.svg", import.meta.url).href,
  codex: new URL("./icons/codex.svg", import.meta.url).href,
  chatgpt: new URL("./icons/chatgpt.svg", import.meta.url).href,
  pi: new URL("./icons/pi.svg", import.meta.url).href,
  "copilot-cli": new URL("./icons/copilot-cli.svg", import.meta.url).href,
};

const MONOCHROME_ICONS = new Set<AppId>(["chatgpt", "copilot-cli"]);

interface HarnessIconProps {
  appId: AppId;
}

export function HarnessIcon({ appId }: HarnessIconProps): JSX.Element {
  return (
    <img
      className={cx(
        "harness-icon",
        MONOCHROME_ICONS.has(appId) && "harness-icon--monochrome",
      )}
      src={ICON_URLS[appId]}
      alt=""
    />
  );
}
