import { useState } from "react";

import { t } from "../../../i18n";
import type { BudgetLimitPutRequest } from "../../../../../src/lib/config/settings-types";
import { Button } from "../../components/Button";
import { ProblemCallout } from "../../components/ProblemCallout";

import { formatInstant, formatSpan } from "./format";
import type { BudgetFormat } from "./hooks";
import { RangePicker } from "./RangePicker";
import { type RangeChoice, rangeChoice } from "./range";
import { useSimulation } from "./useSimulation";
import { WHATIF_PRESETS, simulateRequest, whatIfFacts } from "./whatif";

interface WhatIfPanelProps {
  /** The rule the form describes, or null while it isn't one yet (no amount, say). */
  draft: BudgetLimitPutRequest | null;
  format: BudgetFormat;
  /** The amount now in the form, in the display unit, if it reads as one. */
  currentAmount: number | null;
  /** The rule being edited counts something the replay can't (tokens), so there is nothing to show. */
  unavailable?: boolean;
  /** The rule being edited has an away condition or a request cap, which the replay doesn't apply. */
  simplified?: boolean;
  /** Put the suggestion (display unit, already rounded up) in the amount field. */
  onUseAmount: (amount: number) => void;
}

/**
 * "What if": the rule being typed, replayed over your own history. It asks the
 * server once typing has paused and says when the rule would have warned and
 * reached its limit, what it would have refused, the busiest period it would
 * have met, and an amount that would have fit most periods, which one click
 * puts in the amount field. It only reads: nothing here is saved, and nothing
 * typed is changed except by that click.
 */
export function WhatIfPanel({ draft, format, currentAmount, unavailable = false, simplified = false, onUseAmount }: WhatIfPanelProps): JSX.Element {
  const [choice, setChoice] = useState<RangeChoice>(() => rangeChoice("30d", Date.now()));
  const { result, range, isPending, problem, retry } = useSimulation(simulateRequest(unavailable ? null : draft, choice));
  const facts = draft && result && !unavailable ? whatIfFacts(result) : null;
  const when = (iso: string | null): string => (iso === null ? t("budget-whatif-never") : formatInstant(iso, format.locale, true));
  const unit = facts?.rolling ? "window" : "period";

  return (
    <section className="whatif" aria-labelledby="budget-whatif-title" aria-busy={isPending}>
      <div className="whatif__head">
        <h3 className="whatif__title" id="budget-whatif-title">
          {t("budget-whatif-title")}
        </h3>
        <RangePicker id="budget-whatif-range" value={choice} onChange={setChoice} presets={WHATIF_PRESETS} custom={false} />
      </div>

      {unavailable && <p className="form__hint">{t("budget-whatif-tokens-unavailable")}</p>}
      {!unavailable && !draft && <p className="form__hint">{t("budget-whatif-hint")}</p>}
      {!unavailable && draft && !facts && !problem && <p className="form__hint">{t("budget-whatif-loading")}</p>}
      {!unavailable && draft && problem && <ProblemCallout problem={problem} onRetry={retry} />}

      {draft && facts && range && (
        <div className="whatif__body">
          <p className="form__hint">
            {isPending ?
              t("budget-whatif-updating")
            : t("budget-whatif-intro", { span: formatSpan(range.from, range.to, format.locale) })}
          </p>
          {!facts.anyUsage ?
            <p className="whatif__none">{t("budget-whatif-nothing")}</p>
          : <dl className="whatif__facts">
              <div>
                <dt>{t("budget-whatif-warned")}</dt>
                <dd>{when(facts.warnedAt)}</dd>
              </div>
              <div>
                <dt>{t("budget-whatif-tripped")}</dt>
                <dd>{when(facts.trippedAt)}</dd>
              </div>
              <div>
                <dt>{t("budget-whatif-refused")}</dt>
                <dd>
                  {facts.asks ?
                    t("budget-whatif-asks")
                  : !facts.blocks ?
                    t("budget-whatif-only-warns")
                  : facts.refusedRequests === 0 ?
                    t("budget-whatif-none")
                  : t("budget-whatif-refused-value", {
                      n: facts.refusedRequests,
                      amount: format.money(facts.refusedAmount),
                    })
                  }
                </dd>
              </div>
              <div>
                <dt>{t("budget-whatif-peak", { unit })}</dt>
                <dd>
                  {format.money(facts.peakAmount)}
                  {facts.peakAt && <span className="whatif__when"> {t("budget-whatif-peak-at", { when: formatInstant(facts.peakAt, format.locale) })}</span>}
                </dd>
              </div>
              <div>
                <dt>{t("budget-whatif-matched")}</dt>
                <dd>
                  {t("budget-whatif-matched-value", {
                    n: facts.matchedRequests,
                    amount: format.money(facts.matchedAmount),
                  })}
                </dd>
              </div>
              {facts.periods && (
                <div>
                  <dt>{t("budget-whatif-periods")}</dt>
                  <dd>{t("budget-whatif-periods-value", { tripped: facts.periods.tripped, total: facts.periods.total })}</dd>
                </div>
              )}
            </dl>
          }
          {simplified && <p className="form__hint">{t("budget-whatif-simplified")}</p>}
          {facts.suggested !== null && (
            <div className="whatif__suggest">
              <p className="whatif__suggested">
                <strong>{t("budget-whatif-suggested", { amount: format.money(facts.suggested) })}</strong>
                <span className="form__hint">{t("budget-whatif-suggested-hint", { unit })}</span>
              </p>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onUseAmount(facts.suggested ?? 0)}
                disabled={currentAmount !== null && Math.abs(currentAmount - facts.suggested) < 1e-9}
              >
                {t("budget-whatif-use", { amount: format.money(facts.suggested) })}
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
