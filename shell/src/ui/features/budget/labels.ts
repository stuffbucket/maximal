import { t } from "../../../i18n";

import {
  type ActivityGroup,
  type BudgetScope,
  type ResetDescription,
  formatDayKey,
  formatRelative,
  formatWhen,
} from "./format";
import type { BudgetFormat } from "./hooks";

/** Capabilities Maximal serves itself, with their catalog names. */
const CAPABILITY_KEYS: Record<string, string> = {
  images: "budget-capability-images",
  decisions: "budget-capability-decisions",
  systemone: "budget-capability-systemone",
};

export function capabilityName(id: string): string {
  const key = CAPABILITY_KEYS[id];
  return key ? t(key) : id;
}

export function providerName(id: string): string {
  return id === "copilot" ? t("budget-provider-copilot") : id;
}

/** "Everything", "Client codex", "Plugin Images", "Provider GitHub Copilot". */
export function scopeName(scope: BudgetScope): string {
  switch (scope.kind) {
    case "global":
      return t("budget-scope-global");
    case "key":
      return t("budget-scope-key", { name: scope.id });
    case "plugin":
      return t("budget-scope-plugin", { name: capabilityName(scope.id) });
    case "provider":
      return t("budget-scope-provider", { name: providerName(scope.id) });
    case "filter":
      // A filter is named by its id until the editor can offer them.
      return scope.id;
  }
}

/** The name of one thing a limit can apply to (an option in the editor). */
export function targetName(kind: Exclude<BudgetScope["kind"], "global">, id: string): string {
  if (kind === "plugin") return capabilityName(id);
  if (kind === "provider") return providerName(id);
  return id;
}

/** A group row's name: the model, capability, client, provider or day it stands for. */
export function segmentName(group: ActivityGroup, key: string | null, other: boolean, locale: string): string {
  if (other) return t("budget-other");
  if (key === null || key === "") return group === "plugin" ? t("budget-no-plugin") : t("budget-unknown");
  switch (group) {
    case "plugin":
      return capabilityName(key);
    case "provider":
      return providerName(key);
    case "day":
      return formatDayKey(key, locale);
    default:
      return key;
  }
}

/** When a limit resets, as a sentence: "Resets in 3 hours", "Never resets". */
export function resetText(reset: ResetDescription, format: BudgetFormat): string {
  if (reset.kind === "never") return t("budget-reset-never");
  const relative = formatRelative(reset.resetsAtMs, format.now, format.locale);
  const date = formatWhen(reset.resetsAtMs, format.now, format.locale);
  if (reset.kind === "fallback") return t("budget-reset-fallback", { window: reset.window, relative });
  if (reset.kind === "follow") {
    return t(reset.estimated ? "budget-reset-follow-estimated" : "budget-reset-follow", {
      window: reset.window,
      date,
      relative,
    });
  }
  return t(reset.estimated ? "budget-reset-at-estimated" : "budget-reset-at", { date, relative });
}
