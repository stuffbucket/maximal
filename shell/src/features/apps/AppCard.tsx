import { useId, useState } from "react";

import type { AppEntry, AppInstall } from "../../api";
import { Button } from "../../ui/Button";
import { Switch } from "../../ui/Switch";
import { cx } from "../../ui/cx";

import type { MutationResult } from "./useApps";

const COPIED_FLASH_MS = 1400;

interface AppCardProps {
  app: AppEntry;
  onToggle: (enabled: boolean, path?: string) => Promise<MutationResult>;
  onSelect: (path: string) => Promise<MutationResult>;
  onRescan: () => Promise<void>;
}

/** "Claude Code 1.2.3" when a version is known, else a graceful fallback. */
function versionLabel(name: string, install: AppInstall): string {
  return install.version ? `${name} ${install.version}` : `${name} (version unknown)`;
}

export function AppCard({
  app,
  onToggle,
  onSelect,
  onRescan,
}: AppCardProps): JSX.Element {
  const groupName = useId();
  const [copied, setCopied] = useState(false);
  const [rescanning, setRescanning] = useState(false);

  const comingSoon = app.kind === "coming-soon";
  const notInstalled = app.status === "not-installed";
  const hasInstalls = app.installs.length > 0;
  const offerInstall =
    app.kind === "shimmable" && !hasInstalls && app.install !== null;

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

  return (
    <article
      className={cx("app-card", comingSoon && "app-card--soon")}
      data-app-id={app.id}
    >
      <header className="app-card__head">
        <h3 className="app-card__name">{app.name}</h3>

        <div className="app-card__control">
          {comingSoon ? (
            <span className="chip app-card__pill">Coming soon</span>
          ) : offerInstall ? null : (
            <Switch
              checked={app.enabled}
              disabled={notInstalled}
              onCheckedChange={(next) => void onToggle(next)}
              label={app.enabled ? "On" : "Off"}
            />
          )}
        </div>
      </header>

      {/* Claude Code with no install: offer the one-line installer. */}
      {offerInstall && app.install && (
        <div className="app-card__install">
          <p className="app-card__hint">
            Run this in your terminal to install Claude Code, then re-scan.
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

      {/* Claude Code with installs: pick which one the shim points at. */}
      {app.kind === "shimmable" && hasInstalls && (
        <fieldset
          className="app-versions"
          disabled={!app.enabled}
          aria-disabled={!app.enabled}
        >
          <legend className="app-versions__legend">Active version</legend>
          {app.installs.map((install) => (
            <label
              key={install.path}
              className={cx(
                "app-version",
                install.active && "app-version--active",
              )}
            >
              <input
                type="radio"
                className="app-version__radio"
                name={groupName}
                checked={install.active}
                disabled={!app.enabled}
                onChange={() => void onSelect(install.path)}
              />
              <span className="app-version__detail">
                <span className="app-version__label">
                  {versionLabel(app.name, install)}
                </span>
                <span className="app-version__path mono">{install.path}</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}

      {/* Claude Desktop: single config app — show its location or a
          "not installed" note. No version radios. */}
      {app.kind === "config" &&
        (notInstalled ? (
          <p className="app-card__hint">Not installed.</p>
        ) : (
          app.installs[0] && (
            <p className="app-card__hint mono">{app.installs[0].path}</p>
          )
        ))}
    </article>
  );
}
