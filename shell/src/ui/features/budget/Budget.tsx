import { useBudget } from "./useBudget";
import { useBuiltFormat, useLocale, useNow } from "./hooks";
import { Activity } from "./Activity";
import { Limits } from "./Limits";
import { Settings } from "./Settings";
import { Summary } from "./Summary";

/** What amounts read in until the first status arrives. */
const DEFAULT_DISPLAY = { unit: "usd", credit_usd: 0.01 } as const;

/**
 * The Rules surface (named Budget before): a one-line summary, then Rules, Activity and Settings
 * as typographic sections in one scrolling column (no card grid; the surface's
 * name is in the native title bar, so the first heading is the section's).
 * Rules and Activity are what people come for, so they lead; the settings
 * (enforcement, display unit, the provider's allowances) follow, and the
 * summary keeps the enforcement state in view meanwhile. Everything reads from
 * one live status, so a change in one section shows in the others.
 */
export function Budget(): JSX.Element {
  const locale = useLocale();
  const now = useNow();
  const budget = useBudget();
  const format = useBuiltFormat(budget.status?.display ?? DEFAULT_DISPLAY, locale, now);
  const ready = budget.status ? format : null;

  return (
    <div className="budget">
      <Summary status={budget.status} problem={budget.problem} format={ready} onRetry={() => void budget.refresh()} />
      <Limits status={budget.status} format={ready} version={budget.version} onSave={budget.saveLimit} onDelete={budget.deleteLimit} />
      <Activity format={ready} version={budget.version} />
      <Settings status={budget.status} format={ready} onSetEnabled={budget.setEnabled} onSetUnit={budget.setUnit} />
    </div>
  );
}
