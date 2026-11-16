import { useState } from "react";

import { t } from "../../../i18n";
import type { AppEntry, AppId } from "../../../proxy/client";
import { openUrl, revealPath } from "../../../tauri/shell";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Switch } from "../../components/Switch";
import { isWindows } from "../../platform";

import { TerminalGlyph, WindowGlyph } from "./glyphs";
import { HarnessIcon } from "./HarnessIcon";
import type { MutationResult, ToggleAppOptions } from "./useApps";

const OFFICIAL_APP_URLS: Partial<Record<AppId, string>> = {
  "claude-code": "https://code.claude.com/docs/en/setup",
  "claude-desktop": "https://claude.ai/download",
  codex: "https://learn.chatgpt.com/docs/codex/cli",
};

const HARNESS_TYPES: Record<AppId, "terminal" | "window"> = {
  "claude-code": "terminal",
  "claude-desktop": "window",
  codex: "terminal",
  chatgpt: "window",
  pi: "terminal",
  "copilot-cli": "terminal",
};

const HARNESS_NAMES: Partial<Record<AppId, string>> = {
  "claude-desktop": "Claude Desktop (Cowork, Code)",
};

interface HarnessRowProps {
  app: AppEntry;
  onToggle: (
    enabled: boolean,
    options?: ToggleAppOptions,
  ) => Promise<MutationResult>;
}

function harnessName(app: AppEntry): string {
  return HARNESS_NAMES[app.id] ?? app.name;
}

function conflictDetail(app: AppEntry): string {
  const appName = harnessName(app);
  switch (app.conflict) {
    case "other-maximal-config":
      return t("apps-override-body", { appName });
    case "foreign-base-url":
      return t("apps-conflict-base-url", { appName });
    case "foreign-api-key-helper":
      return t("apps-conflict-api-key-helper", { appName });
    case "cleanup-required":
      return t("apps-conflict-cleanup-detail", { appName });
    case "foreign-gateway-profile":
      return t("apps-conflict-gateway-profile", { appName });
    case null:
      return "";
  }
}

async function openOfficialInstructions(app: AppEntry): Promise<void> {
  const url = OFFICIAL_APP_URLS[app.id];
  if (!url) return;
  try {
    await openUrl(url);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

function HarnessTypeIcon({ appId }: { appId: AppId }): JSX.Element {
  const type = HARNESS_TYPES[appId];
  const label = t(
    type === "terminal" ? "apps-install-kind-cli" : "apps-install-kind-desktop",
  );
  return (
    <span className="harness-row__type-icon" aria-label={label} title={label}>
      {type === "terminal" ? <TerminalGlyph /> : <WindowGlyph />}
    </span>
  );
}

export function HarnessRow({ app, onToggle }: HarnessRowProps): JSX.Element {
  const [connectOpen, setConnectOpen] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [restartWarnOpen, setRestartWarnOpen] = useState(false);
  const [disabling, setDisabling] = useState(false);

  const displayName = harnessName(app);
  const comingSoon = app.kind === "coming-soon";
  const notInstalled = app.status === "not-installed";
  const hasConflict = !notInstalled && app.conflict !== null;
  const needsConnection = notInstalled || hasConflict;
  const canTransfer = app.conflict === "other-maximal-config";
  const needsWindowsRestartWarning = app.id === "claude-code" && isWindows();
  const preferredInstall =
    app.installs.find((install) => install.kind === "desktop") ??
    app.installs[0];

  const handleToggle = (next: boolean): void => {
    if (!next && needsWindowsRestartWarning) {
      setRestartWarnOpen(true);
      return;
    }
    void onToggle(next);
  };

  const confirmConnect = async (): Promise<void> => {
    if (notInstalled) {
      setConnectOpen(false);
      await openOfficialInstructions(app);
      return;
    }
    if (canTransfer) {
      setConnecting(true);
      const result = await onToggle(true, { overrideOtherMaximal: true });
      setConnecting(false);
      if (result.ok) setConnectOpen(false);
      return;
    }
    setConnectOpen(false);
  };

  const confirmDisable = async (): Promise<void> => {
    setDisabling(true);
    await onToggle(false);
    setDisabling(false);
    setRestartWarnOpen(false);
  };

  const connectTitle = notInstalled
    ? t("apps-download-title", { appName: displayName })
    : canTransfer
      ? t("apps-override-title", { appName: displayName })
      : t("apps-connect-title", { appName: displayName });
  const connectBody = notInstalled
    ? t("apps-download-body", { appName: displayName })
    : canTransfer
      ? t("apps-override-body", { appName: displayName })
      : conflictDetail(app);
  const connectConfirmLabel = notInstalled
    ? t("apps-download-confirm")
    : canTransfer
      ? t("apps-connect")
      : t("common-close");

  return (
    <tr className="harness-row" data-app-id={app.id}>
      <td>
        <div className="harness-row__identity">
          <span className="harness-row__icon" aria-hidden="true">
            <HarnessIcon appId={app.id} />
          </span>
          {preferredInstall && !notInstalled ? (
            <button
              type="button"
              className="harness-row__name harness-row__name--link"
              aria-label={t("apps-open-app", { appName: displayName })}
              onClick={() => void revealPath(preferredInstall.path)}
            >
              {displayName}
            </button>
          ) : (
            <span className="harness-row__name">{displayName}</span>
          )}
        </div>
      </td>
      <td className="harness-row__type">
        <HarnessTypeIcon appId={app.id} />
      </td>
      <td className="harness-row__action">
        {comingSoon ? (
          <span className="harness-row__coming-soon">
            {t("apps-coming-soon")}
          </span>
        ) : needsConnection ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setConnectOpen(true)}
          >
            {t("apps-connect")}
          </Button>
        ) : (
          <Switch
            checked={app.enabled}
            onCheckedChange={handleToggle}
            label={t("apps-toggle-aria", { appName: displayName })}
            hideLabel
          />
        )}

        {!comingSoon && needsConnection && (
          <ConfirmDialog
            open={connectOpen}
            title={connectTitle}
            body={<p>{connectBody}</p>}
            confirmLabel={connectConfirmLabel}
            cancelLabel={hasConflict && !canTransfer ? null : t("apps-cancel")}
            busy={connecting}
            onConfirm={confirmConnect}
            onCancel={() => setConnectOpen(false)}
          />
        )}

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
      </td>
    </tr>
  );
}
