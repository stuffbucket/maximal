import { useRef, useState } from "react";

import { t } from "../../../i18n";

import type { AppEntry } from "../../../proxy/client";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Switch } from "../../components/Switch";
import { cx } from "../../components/cx";
import { isWindows } from "../../platform";

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
        title: "Left your existing setting in place",
        detail:
          `${app.name} already has a custom ANTHROPIC_BASE_URL set by you or` +
          " another tool, so we didn't change it. Remove that line from the" +
          " app's settings, then switch this on again to route through maximal.",
      };
    case "foreign-api-key-helper":
      return {
        title: "Left your existing setting in place",
        detail:
          `${app.name} already has a custom apiKeyHelper set by you or` +
          " another tool, so we didn't change it. Remove that line from the" +
          " app's settings, then switch this on again to route through maximal.",
      };
    case null:
      return null;
  }
}

export function AppCard({
  app,
  onToggle,
  onRescan,
}: AppCardProps): JSX.Element {
  const [copied, setCopied] = useState(false);
  const [rescanning, setRescanning] = useState(false);
  const [toggling, setToggling] = useState(false);
  const pending = useRef(false);
  const [connecting, setConnecting] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);
  const isCodex = app.id === "codex" || app.id === "codex-desktop";
  const needsUpdate = isCodex && app.enabled && app.routing?.automatic_review !== true;
  const [toggleError, setToggleError] = useState<string | null>(null);
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
  // Config apps with no detected install offer a one-line installer +
  // re-scan (currently only Claude Code ships an install hint).
  const offerInstall =
    app.kind === "config" &&
    !hasInstalls &&
    app.install !== null &&
    !app.enabled;
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

  const rescan = async (): Promise<void> => {
    setRescanning(true);
    await onRescan();
    setRescanning(false);
  };

  // Intercept only the Claude-Code-disable-on-Windows case; everything else
  // (enabling, other apps, macOS) toggles straight through.
  const toggle = async (next: boolean): Promise<void> => {
    if (pending.current) return;
    pending.current = true;
    setToggling(true);
    setConnecting(next);
    setToggleError(null);
    try {
      const result = await onToggle(next);
      if (!result.ok)
        setToggleError(result.error ?? t("apps-configuration-error"));
      else if (result.restartRequired) setRestartRequired(true);
    } catch {
      setToggleError(t("apps-configuration-error"));
    } finally {
      pending.current = false;
      setToggling(false);
    }
  };

  const handleToggle = (next: boolean): void => {
    if (!next && needsWindowsRestartWarning) {
      setRestartWarnOpen(true);
      return;
    }
    void toggle(next);
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
      aria-busy={toggling}
    >
      <header className="app-card__head">
        <h3 className="app-card__name">{app.name}</h3>

        <div className="app-card__control">
          {comingSoon ? (
            <span className="chip app-card__pill">Coming soon</span>
          ) : isCodex ? (
            <>
              {needsUpdate && !notInstalled && (
                <Button variant="primary" size="sm" disabled={toggling}
                  onClick={() => void toggle(true)}>
                  {t(toggling && connecting ? "apps-configuring" : "apps-codex-update")}
                </Button>
              )}
              <Switch
                checked={app.enabled}
                disabled={toggling || (notInstalled && !app.enabled)}
                onCheckedChange={handleToggle}
                label={toggling ? t("common-working") : app.enabled ? "On" : "Off"}
              />
            </>
          ) : offerInstall ? null : (
            <Switch
              checked={app.enabled}
              disabled={toggling || (notInstalled && !app.enabled)}
              onCheckedChange={handleToggle}
              label={toggling ? "Working…" : app.enabled ? "On" : "Off"}
            />
          )}
        </div>
      </header>

      {isCodex && (
        <div className="app-card__install">
          <p className="app-card__hint">{t(needsUpdate ? "apps-codex-update-help"
            : app.enabled ? "apps-codex-review-configured" : "apps-codex-approval-help")}</p>
          {(app.enabled || restartRequired) && (
            <p className="app-card__hint" role="status">{t("apps-codex-review-restart")}</p>
          )}
        </div>
      )}
      {(app.id === "codex" || app.id === "codex-desktop") && app.routing &&
        (app.routing.notice || (app.routing.managed && !app.enabled)) && (
        <div className="app-card__install">
          {app.routing.notice && (
            <p className="app-card__hint" role="status">
              {app.routing.notice}
            </p>
          )}
          {app.routing.managed && !app.enabled && (
            <Button
              variant="secondary"
              size="sm"
              disabled={toggling}
              onClick={() => void toggle(false)}
            >
              Remove Maximal settings
            </Button>
          )}
        </div>
      )}
      {toggleError && (
        <p className="state__caption state__caption--error" role="alert">
          {toggleError}
        </p>
      )}

      {/* Config app with no install: offer the one-line installer. */}
      {offerInstall && app.install && (
        <div className="app-card__install">
          <p className="app-card__hint">
            Run this in your terminal to install {app.name}, then re-scan.
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
                {copied ? "Copied" : "Copy command"}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={rescanning}
                onClick={() => void rescan()}
              >
                {rescanning ? "Re-scanning…" : "Re-scan"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Config app with an install: show its location, or a "not
          installed" note. No version picker — routing is by config file,
          not a per-binary shim. */}
      {app.kind === "config" &&
        !offerInstall &&
        (notInstalled ? (
          <p className="app-card__hint">Not installed.</p>
        ) : (
          app.installs.map((install) => (
            <p key={install.path} className="app-card__hint mono">{install.path}</p>
          ))
        ))}

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
          title="Restart Claude Code to finish"
          body={
            <>
              <p>
                On Windows, a Claude Code session that's already running keeps
                routing through maximal until you restart it.
              </p>
              <p>
                After you disable this, run <code className="mono">/exit</code>{" "}
                in Claude Code and start it again for the change to take effect.
              </p>
            </>
          }
          confirmLabel="Disable routing"
          cancelLabel="Keep on"
          busy={disabling}
          onConfirm={confirmDisable}
          onCancel={() => setRestartWarnOpen(false)}
        />
      )}
    </article>
  );
}
