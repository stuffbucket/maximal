import { t } from "../../../i18n";
import type { PluginStatusState, PluginView } from "../../../proxy/client";

/**
 * How a connector reads: a tone for the dot and some text.
 *
 * The tone comes from the connector's own `status.state` while it runs;
 * before that (starting) it comes from the lifecycle. The detail page's line
 * is the connector's English `status.summary`, rendered as-is, except while
 * Maximal is still starting it. The list's label is Maximal's own short word.
 */
export type ConnectorTone = PluginStatusState;

export interface ConnectorLine {
  tone: ConnectorTone;
  /** Names the tone for people who can't see the dot's color. */
  toneLabel: string;
  text: string;
}

function toneLabel(tone: ConnectorTone): string {
  switch (tone) {
    case "ready":
      return t("connectors-status-ready");
    case "needs-setup":
      return t("connectors-status-needs-setup");
    case "working":
      return t("connectors-status-working");
    case "error":
      return t("connectors-status-error");
  }
}

/** `null` when there is nothing to say: off (the switch says so) or failed. */
export function connectorLine(connector: PluginView): ConnectorLine | null {
  const line = (tone: ConnectorTone, text: string): ConnectorLine => ({
    tone,
    toneLabel: toneLabel(tone),
    text,
  });
  if (!connector.enabled || connector.lifecycle === "disabled") return null;
  // A failed connector has no status line; the page shows why it didn't start.
  if (connector.lifecycle === "failed") return null;
  if (connector.lifecycle === "starting") {
    return line("working", t("connectors-line-starting"));
  }
  if (connector.status) return line(connector.status.state, connector.status.summary);
  return line("ready", t("connectors-line-running"));
}

/** The list's Status column: a check when it's ready, else a dot + a word. */
export type ListStatus =
  | { kind: "ready"; label: string }
  | { kind: "dot"; tone: ConnectorTone | "off"; label: string };

export function listStatus(connector: PluginView): ListStatus {
  if (!connector.enabled || connector.lifecycle === "disabled") {
    return { kind: "dot", tone: "off", label: t("connectors-status-off") };
  }
  if (connector.lifecycle === "failed") {
    return { kind: "dot", tone: "error", label: t("connectors-status-failed") };
  }
  if (connector.lifecycle === "starting") {
    return { kind: "dot", tone: "working", label: t("connectors-status-starting") };
  }
  const state = connector.status?.state ?? "ready";
  if (state === "ready") return { kind: "ready", label: t("connectors-status-ready") };
  return { kind: "dot", tone: state, label: toneLabel(state) };
}

export function typeLabel(connector: PluginView): string {
  return connector.source === "built-in"
    ? t("connectors-type-built-in")
    : t("connectors-type-external");
}
