import { useEffect, useRef, useState } from "react";

import { t } from "../../../i18n";
import type { AppEntry, AppId } from "../../../proxy/client";
import { openUrl, revealPath } from "../../../tauri/shell";
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { NoticeDialog } from "../../components/NoticeDialog";
import { Switch } from "../../components/Switch";
import { isWindows } from "../../platform";

import { desktopRestartChange, type DesktopChange } from "./desktop-restart";
import { DesktopRestartDialog } from "./DesktopRestartDialog";
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

/** Anthropic calls the desktop app "Claude"; ids and config paths keep
 *  `claude-desktop`. */
const HARNESS_NAMES: Partial<Record<AppId, string>> = {
  "claude-desktop": "Claude",
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
    case "unreadable-profile":
      return t("apps-conflict-unreadable-profile", { appName });
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
  // Claude Desktop reads its gateway profile at launch, so a change in
  // either direction only reaches an already-running Desktop after it is
  // quit and reopened. Said in a dialog once the change has been applied.
  const [restartNotice, setRestartNotice] = useState<DesktopChange | null>(
    null,
  );
  const restartDialogWasOpen = useRef(false);
  const rowRef = useRef<HTMLTableRowElement>(null);
  // Overrides confirmed since the Connect dialog opened.
  const granted = useRef<ToggleAppOptions>({});
  const [connectProblem, setConnectProblem] = useState<{
    tone: "error" | "notice";
    title: string;
    detail?: string;
  } | null>(null);

  const displayName = harnessName(app);
  const comingSoon = app.kind === "coming-soon";
  const notInstalled = app.status === "not-installed";
  const hasConflict = !notInstalled && app.conflict !== null;
  const needsConnection = notInstalled || hasConflict;
  const canTransfer = app.conflict === "other-maximal-config";
  // Only Claude Desktop can switch away from a gateway it didn't set up
  // without changing it (the other profile stays saved for disable).
  const canTakeOver =
    app.id === "claude-desktop" && app.conflict === "foreign-gateway-profile";
  const needsWindowsRestartWarning = app.id === "claude-code" && isWindows();
  const preferredInstall =
    app.installs.find((install) => install.kind === "desktop") ??
    app.installs[0];

  // The browser hands focus back to whatever opened the restart dialog. After
  // a Connect that control is gone (the switch replaced it), so land on the
  // switch instead of leaving focus on the page — or on the just-closed
  // dialog itself, where a backdrop press leaves it.
  useEffect(() => {
    if (restartNotice !== null) {
      restartDialogWasOpen.current = true;
      return;
    }
    if (!restartDialogWasOpen.current) return;
    restartDialogWasOpen.current = false;
    const active = document.activeElement;
    if (
      active === null ||
      active === document.body ||
      (active instanceof HTMLDialogElement && !active.open)
    ) {
      rowRef.current?.querySelector<HTMLInputElement>(".switch input")?.focus();
    }
  }, [restartNotice]);

  const handleToggle = (next: boolean): void => {
    if (!next && needsWindowsRestartWarning) {
      setRestartWarnOpen(true);
      return;
    }
    void applyToggle(next);
  };

  const applyToggle = async (next: boolean): Promise<void> => {
    setRestartNotice(desktopRestartChange(app.id, next, await onToggle(next)));
  };

  const confirmConnect = async (): Promise<void> => {
    if (notInstalled) {
      setConnectOpen(false);
      await openOfficialInstructions(app);
      return;
    }
    if (canTransfer || canTakeOver) {
      // Each override was confirmed in its own dialog; a second step (a
      // transfer that then meets another gateway, or the reverse) sends
      // both, never more than the person agreed to while this was open.
      granted.current = {
        ...granted.current,
        ...(canTransfer
          ? { overrideOtherMaximal: true }
          : { overrideForeignGateway: true }),
      };
      setConnecting(true);
      setConnectProblem(null);
      const result = await onToggle(true, granted.current);
      setConnecting(false);
      if (result.ok && result.applied) {
        setConnectOpen(false);
        setRestartNotice(desktopRestartChange(app.id, true, result));
        return;
      }
      // Refused or failed: stay open, say so, and let the (possibly new)
      // conflict below explain what's left.
      setConnectProblem(
        result.ok
          ? { tone: "notice", title: t("apps-override-refused") }
          : {
              tone: "error",
              title: t("apps-override-failed", { appName: displayName }),
              detail: result.error,
            },
      );
      return;
    }
    setConnectOpen(false);
  };

  const openConnect = (): void => {
    granted.current = {};
    setConnectProblem(null);
    setConnectOpen(true);
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
      : canTakeOver
        ? t("apps-takeover-body", { appName: displayName })
        : conflictDetail(app);
  const connectConfirmLabel = notInstalled
    ? t("apps-download-confirm")
    : canTransfer
      ? t("apps-connect")
      : t("common-close");
  const connectDialogBody = (
    <>
      {connectProblem && (
        <Callout tone={connectProblem.tone} title={connectProblem.title}>
          {connectProblem.detail}
        </Callout>
      )}
      <p>{connectBody}</p>
    </>
  );

  return (
    <tr ref={rowRef} className="harness-row" data-app-id={app.id}>
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
            onClick={openConnect}
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

        {!comingSoon && needsConnection && canTakeOver && (
          // Maximal left the other gateway alone; Close (the default, first
          // focus, Escape and the backdrop) keeps it that way. Take over is
          // the explicit alternative.
          <NoticeDialog
            open={connectOpen}
            title={connectTitle}
            actionLabel={t("common-close")}
            onDismiss={() => setConnectOpen(false)}
            secondaryAction={{
              label: t("apps-take-over"),
              tone: "danger",
              onAction: confirmConnect,
            }}
            busy={connecting}
          >
            {connectDialogBody}
          </NoticeDialog>
        )}

        {!comingSoon && needsConnection && !canTakeOver && (
          <ConfirmDialog
            open={connectOpen}
            title={connectTitle}
            body={connectDialogBody}
            confirmLabel={connectConfirmLabel}
            cancelLabel={hasConflict && !canTransfer ? null : t("apps-cancel")}
            busy={connecting}
            onConfirm={confirmConnect}
            onCancel={() => setConnectOpen(false)}
          />
        )}

        {/* Claude Desktop only: after an applied enable or disable (from the
            switch or a Connect), a dialog says a running Desktop must be quit
            and reopened. A refusal turns the switch into Connect instead; a
            failed request shows the panel problem. Informational — the change
            is already made. */}
        {app.id === "claude-desktop" && (
          <DesktopRestartDialog
            change={restartNotice}
            onDismiss={() => setRestartNotice(null)}
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
