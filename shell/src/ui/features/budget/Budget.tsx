import { useBudget } from "./useBudget";
import { useBuiltFormat, useLocale, useNow } from "./hooks";
import { Activity } from "./Activity";
import { Limits } from "./Limits";
import { Overview } from "./Overview";

/** What amounts read in until the first status arrives. */
const DEFAULT_DISPLAY = { unit: "usd", credit_usd: 0.01 } as const;

/**
 * The Budget surface: Overview, Limits and Activity as three typographic
 * sections in one scrolling column (no card grid; the surface's name is in the
 * native title bar, so the first heading is the section's). Everything reads
 * from one live status, so a change in one section shows in the others.
 */
export function Budget(): JSX.Element {
  const locale = useLocale();
  const now = useNow();
  const budget = useBudget();
  const format = useBuiltFormat(budget.status?.display ?? DEFAULT_DISPLAY, locale, now);
  const ready = budget.status ? format : null;

  return (
    <div className="budget">
      <Overview
        status={budget.status}
        problem={budget.problem}
        format={ready}
        onRetry={() => void budget.refresh()}
        onSetEnabled={budget.setEnabled}
        onSetUnit={budget.setUnit}
      />
      <Limits status={budget.status} format={ready} onSave={budget.saveLimit} onDelete={budget.deleteLimit} />
      <Activity format={ready} version={budget.version} />
    </div>
  );
}
