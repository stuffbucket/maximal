import { useRef, useState } from "react";

import { t } from "../../../i18n";
import type { AppEntry, AppInstallHint } from "../../../proxy/client";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useRecheckWhileVisible } from "../../recheck";

import { useClaudeCodeInstall } from "./useClaudeCodeInstall";

const COPIED_FLASH_MS = 1400;

interface InstallOfferProps {
  app: AppEntry;
  install: AppInstallHint;
  onRescan: () => Promise<void>;
}

/** Explains the reason a WinGet install failed, in the catalog. */
function failureReason(
  reason: string | null,
  exitCode: number | null,
): string {
  switch (reason) {
    case "winget-missing":
      return t("apps-install-reason-winget-missing");
    case "timed-out":
      return t("apps-install-reason-timed-out");
    case "exit-code":
      return t("apps-install-reason-exit-code", {
        code: String(exitCode ?? "?"),
      });
    case "not-found-after-install":
      return t("apps-install-reason-not-found");
    default:
      return t("apps-install-reason-error");
  }
}

/**
 * The card's install block for a config app with no install found. Windows
 * can offer a one-click WinGet install (after a confirm); every platform keeps
 * the command to copy. Re-detects the app while it waits for the install.
 */
export function InstallOffer({
  app,
  install,
  onRescan,
}: InstallOfferProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useRecheckWhileVisible(ref, onRescan, true);
  const [copied, setCopied] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const automatic = install.automatic === "winget";
  const { status, startError, start } = useClaudeCodeInstall(
    onRescan,
    automatic,
  );

  const running = status?.state === "running";
  const succeeded = status?.state === "succeeded";
  const failed = status?.state === "failed";
  const output = status?.output ?? [];

  const copyInstall = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(install.command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), COPIED_FLASH_MS);
    } catch {
      // Clipboard unavailable (insecure context / plain browser). The command
      // is also shown in a code block the user can select.
    }
  };

  const confirmInstall = async (): Promise<void> => {
    setConfirmOpen(false);
    await start();
  };

  return (
    <div className="app-card__install" ref={ref}>
      {automatic && running && (
        <div className="app-card__progress" role="status" aria-live="polite">
          <p className="app-card__hint">{t("apps-install-running")}</p>
          {output.length > 0 && (
            <pre className="app-card__output mono">{output[output.length - 1]}</pre>
          )}
        </div>
      )}

      {automatic && (failed || startError !== null) && (
        <div className="app-card__conflict" role="alert">
          <div className="app-card__conflict-text">
            <span className="app-card__conflict-title">
              {t("apps-install-failed-title")}
            </span>
            <span className="app-card__conflict-detail">
              {startError !== null ?
                t("apps-install-start-failed", { error: startError })
              : failureReason(status?.reason ?? null, status?.exitCode ?? null)}
            </span>
            {failed && output.length > 0 && (
              <pre className="app-card__output mono">
                {output.join("\n")}
              </pre>
            )}
          </div>
        </div>
      )}

      {automatic && !running && !succeeded && (
        <div className="app-card__cmd-actions">
          <Button
            variant="primary"
            size="sm"
            onClick={() => setConfirmOpen(true)}
          >
            {failed || startError !== null ?
              t("apps-install-retry")
            : t("apps-install-automatic-button")}
          </Button>
        </div>
      )}

      <p className="app-card__hint">
        {automatic ?
          t("apps-install-or-powershell")
        : t("install-run-in-terminal", { name: app.name })}
      </p>
      <div className="app-card__cmd">
        <code className="app-card__cmd-text mono">{install.command}</code>
        <div className="app-card__cmd-actions">
          <Button
            variant={automatic ? "secondary" : "primary"}
            size="sm"
            onClick={() => void copyInstall()}
          >
            {copied ? t("common-copied") : t("apps-copy-command")}
          </Button>
        </div>
      </div>
      <p className="app-card__hint">
        {t("apps-install-then", { appName: app.name })}
      </p>

      {automatic && (
        <ConfirmDialog
          open={confirmOpen}
          title={t("apps-install-confirm-title")}
          body={
            <>
              <p>{t("apps-install-confirm-body")}</p>
              <p>
                <code className="mono">winget install --id Anthropic.ClaudeCode</code>
              </p>
            </>
          }
          confirmLabel={t("apps-install-confirm-action")}
          cancelLabel={t("common-cancel")}
          onConfirm={confirmInstall}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </div>
  );
}
