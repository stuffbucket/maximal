import { t } from "../../../i18n";
import type { PluginStatusState, PluginView } from "../../../proxy/client";

/**
 * How a plugin reads in the list: a tone for the dot and one line of text.
 *
 * The tone comes from the plugin's own `status.state` while it runs; before
 * that (starting) it comes from the lifecycle. The line is the
 * plugin's English `status.summary`, rendered as-is, except while Maximal
 * is still starting it.
 */
export type PluginTone = PluginStatusState;

export interface PluginLine {
  tone: PluginTone;
  /** Names the tone for people who can't see the dot's color. */
  toneLabel: string;
  text: string;
}

function toneLabel(tone: PluginTone): string {
  switch (tone) {
    case "ready":
      return t("plugins-state-ready");
    case "needs-setup":
      return t("plugins-state-needs-setup");
    case "working":
      return t("plugins-state-working");
    case "error":
      return t("plugins-state-error");
  }
}

/** `null` when there is nothing to say: off (the switch says so) or failed. */
export function pluginLine(plugin: PluginView): PluginLine | null {
  const line = (tone: PluginTone, text: string): PluginLine => ({
    tone,
    toneLabel: toneLabel(tone),
    text,
  });
  if (!plugin.enabled || plugin.lifecycle === "disabled") return null;
  // A failed plugin has no status line; the card shows why it didn't start.
  if (plugin.lifecycle === "failed") return null;
  if (plugin.lifecycle === "starting") {
    return line("working", t("plugins-line-starting"));
  }
  if (plugin.status) return line(plugin.status.state, plugin.status.summary);
  return line("ready", t("plugins-line-running"));
}
