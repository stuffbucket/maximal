/**
 * Where a rule's warnings and limit notices go. A rule can say for each of
 * the two (`notify.warn`, `notify.limit`): `none`, a native `notification`,
 * the menu-bar `tray` list, or `both`. What it doesn't say takes the
 * default: a warning is a notification, reaching the limit is both.
 */

import type { BudgetLimitConfig, BudgetNotifyChannel } from "./schema"

export interface ResolvedNotify {
  warn: BudgetNotifyChannel
  limit: BudgetNotifyChannel
}

export const DEFAULT_NOTIFY: ResolvedNotify = {
  warn: "notification",
  limit: "both",
}

export function resolveNotify(
  limit: Pick<BudgetLimitConfig, "notify">,
): ResolvedNotify {
  return {
    warn: limit.notify?.warn ?? DEFAULT_NOTIFY.warn,
    limit: limit.notify?.limit ?? DEFAULT_NOTIFY.limit,
  }
}
