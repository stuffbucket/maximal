import { useEffect, useRef, useState } from "react";

import { Button } from "./Button";

const COPIED_FLASH_MS = 1400;

/** How often to look again while the steps are on screen. A look is file
 *  probes and cached values on the proxy, so this is cheap. */
export const INSTALL_POLL_MS = 3_000;

interface InstallStepsProps {
  /** What gets installed ("Work IQ"). */
  name: string;
  /** The one-line terminal command that installs it. */
  command: string;
  /** Step 2, in the user's terms ("Connect Maximal to Work IQ"). */
  connectTitle: string;
  /** What happens once it's installed ("Then add it here."). */
  connectHint: string;
  /** Look for the install again. Must be a stable callback. */
  onCheck: () => Promise<void>;
  /** How often to look while the steps are on screen. Returning to the
   *  window always looks. */
  pollMs?: number;
}

/**
 * Install something from the terminal, then carry on here. Two numbered
 * steps instead of a command with a "re-scan" button beside it: Maximal
 * looks for the install itself — when the window comes back to the front
 * (the user returning from their terminal) and every few seconds while it's
 * on screen — so finishing the install is the whole of step 1, and the card
 * moves on by itself.
 */
export function InstallSteps({
  name,
  command,
  connectTitle,
  connectHint,
  onCheck,
  pollMs = INSTALL_POLL_MS,
}: InstallStepsProps): JSX.Element {
  const [copied, setCopied] = useState(false);
  const root = useRef<HTMLOListElement>(null);

  useEffect(() => {
    let checking = false;
    // Settings keeps every section mounted and hides the others, so only
    // look while this one is actually showing.
    const check = (): void => {
      const onScreen =
        document.visibilityState === "visible" &&
        root.current !== null &&
        root.current.closest("[hidden]") === null;
      if (!onScreen || checking) return;
      checking = true;
      void onCheck().finally(() => {
        checking = false;
      });
    };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    const timer = window.setInterval(check, pollMs);
    return () => {
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
      window.clearInterval(timer);
    };
  }, [onCheck, pollMs]);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), COPIED_FLASH_MS);
    } catch {
      // Clipboard unavailable; the command is shown to select by hand.
    }
  };

  return (
    <ol className="install-steps" ref={root}>
      <li className="install-steps__step">
        <p className="install-steps__title">Install {name} in your terminal</p>
        <div className="install-steps__cmd">
          <code className="install-steps__cmd-text mono">{command}</code>
          <Button variant="primary" size="sm" onClick={() => void copy()}>
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      </li>
      <li className="install-steps__step">
        <p className="install-steps__title">{connectTitle}</p>
        <p className="install-steps__hint">
          Maximal notices when {name} is installed. {connectHint}
        </p>
      </li>
    </ol>
  );
}
