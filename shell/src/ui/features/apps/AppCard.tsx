import { useRef, useState } from "react";

import { t } from "../../../i18n";
import type { AppEntry } from "../../../proxy/client";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Switch } from "../../components/Switch";
import { cx } from "../../components/cx";
import { isWindows } from "../../platform";
import { useRecheckWhileVisible } from "../../recheck";

import type { MutationResult } from "./useApps";

const COPIED_FLASH_MS = 1400;

interface AppCardProps {
  app: AppEntry;
  onToggle: (enabled: boolean) => Promise<MutationResult>;
  onRescan: () => Promise<void>;
}

/** Human-readable explanation + remedy for each refused-enable reason.
 *  Never a dead-end: every conflict says what happened and the one thing
 *  to do about it. */
function conflictCopy(app: AppEntry): { title: string; detail: string } | null {
  switch (app.conflict) {
    case "foreign-base-url":
      return {
        title: t("apps-conflict-existing-title"),
        detail: t("apps-conflict-base-url", { appName: app.name }),
      };
    case "foreign-api-key-helper":
      return {
        title: t("apps-conflict-existing-title"),
        detail: t("apps-conflict-api-key-helper", { appName: app.name }),
      };
    case "cleanup-required":
      return {
        title: t("apps-conflict-cleanup-title"),
        detail: t("apps-conflict-cleanup-detail", { appName: app.name }),
      };
    case "foreign-gateway-profile":
      return {
        title: t("apps-conflict-existing-title"),
        detail: t("apps-conflict-gateway-profile", { appName: app.name }),
      };
    case null:
      return null;
  }
}

export function AppCard({ app, onToggle, onRescan }: AppCardProps): JSX.Element {
  const [copied, setCopied] = useState(false);
  // Windows-only: disabling Claude Code routing doesn't take effect in an
  // already-running session (Claude Code reads its base URL at launch on
  // Windows; macOS picks it up live). Warn before disabling so the user
  // knows to /exit and relaunch. See issue #178.
  const [restartWarnOpen, setRestartWarnOpen] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const needsWindowsRestartWarning = app.id === "claude-code" && isWindows();

  const comingSoon = app.kind === "coming-soon";
  const notInstalled = app.status === "not-installed";
  const hasInstalls = app.installs.length > 0;
  // Config apps with no detected install offer a one-line installer and
  // look for the install on their own (currently only Claude Code ships an
  // install hint).
  const offerInstall =
    app.kind === "config" && !hasInstalls && app.install !== null;
  const conflict = conflictCopy(app);

  const copyInstall = async (): Promise<void> => {
    if (!app.install) return;
    try {
      await navigator.clipboard.writeText(app.install.command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), COPIED_FLASH_MS);
    } catch {
      // Clipboard unavailable (insecure context / plain browser). Silent —
      // the command is also shown in a code block the user can select.
    }
  };

  const installRef = useRef<HTMLDivElement>(null);
  useRecheckWhileVisible(installRef, onRescan, offerInstall);

  // Intercept only the Claude-Code-disable-on-Windows case; everything else
  // (enabling, other apps, macOS) toggles straight through.
  const handleToggle = (next: boolean): void => {
    if (!next && needsWindowsRestartWarning) {
      setRestartWarnOpen(true);
      return;
    }
    void onToggle(next);
  };

  const confirmDisable = async (): Promise<void> => {
    setDisabling(true);
    await onToggle(false);
    setDisabling(false);
    setRestartWarnOpen(false);
  };

  return (
    <article
      className={cx("app-card", comingSoon && "app-card--soon")}
      data-app-id={app.id}
    >
      <header className="app-card__head">
        <h3 className="app-card__name">{app.name}</h3>

        <div className="app-card__control">
          {comingSoon ? (
            <span className="chip app-card__pill">
              {t("apps-coming-soon")}
            </span>
          ) : offerInstall ? null : (
            <Switch
              checked={app.enabled}
              disabled={notInstalled}
              onCheckedChange={handleToggle}
              label={app.enabled ? t("apps-switch-on") : t("apps-switch-off")}
            />
          )}
        </div>
      </header>

      {/* Config app with no install: offer the one-line installer. */}
      {offerInstall && app.install && (
        <div className="app-card__install" ref={installRef}>
          <p className="app-card__hint">
            {t("install-run-in-terminal", { name: app.name })}
          </p>
          <div className="app-card__cmd">
            <code className="app-card__cmd-text mono">
              {app.install.command}
            </code>
            <div className="app-card__cmd-actions">
              <Button
                variant="primary"
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
        </div>
      )}

      {/* Config apps show every detected surface as a flat row. Routing is by
          shared config, not a per-binary shim or nested app card. */}
      {app.kind === "config" &&
        !offerInstall &&
        (notInstalled ? (
          <p className="app-card__hint">{t("apps-not-installed")}</p>
        ) : (
          <div className="app-card__installs">
            {app.installs.map((install) => (
              <div className="app-card__install-row" key={install.path}>
                {install.kind && (
                  <span className="app-card__install-kind">
                    {install.kind === "cli"
                      ? t("apps-install-kind-cli")
                      : t("apps-install-kind-desktop")}
                  </span>
                )}
                <span className="app-card__install-path mono">
                  {install.path}
                </span>
              </div>
            ))}
          </div>
        ))}

      {app.id === "codex" && !notInstalled && (
        <ul className="app-card__guidance">
          <li>{t("apps-codex-shared-setting")}</li>
          <li>{t("apps-codex-restart-session")}</li>
          <li>{t("apps-codex-settings-unchanged")}</li>
          <li>{t("apps-codex-settings-precedence")}</li>
        </ul>
      )}

      {/* Enable was refused (e.g. a base URL we don't own). Explain it and
          point at the fix — the toggle silently snapping back would be a
          mystery dead-end otherwise. */}
      {conflict && (
        <div className="app-card__conflict" role="status">
          <span className="app-card__conflict-icon" aria-hidden="true">
            {/* triangle-alert */}
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </span>
          <span className="app-card__conflict-text">
            <span className="app-card__conflict-title">{conflict.title}</span>
            <span className="app-card__conflict-detail">{conflict.detail}</span>
          </span>
        </div>
      )}

      {/* Windows-only heads-up before disabling Claude Code routing: a
          running session keeps using the proxy until it's restarted. */}
      {needsWindowsRestartWarning && (
        <ConfirmDialog
          open={restartWarnOpen}
          title={t("apps-restart-title")}
          body={
            <>
              <p>{t("apps-restart-windows-body")}</p>
              <p>
                {t("apps-restart-after-disable", { exitCommand: "/exit" })}
              </p>
            </>
          }
          confirmLabel={t("apps-disable-routing")}
          cancelLabel={t("apps-keep-on")}
          busy={disabling}
          onConfirm={confirmDisable}
          onCancel={() => setRestartWarnOpen(false)}
        />
      )}
    </article>
  );
}
