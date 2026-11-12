import { useState } from "react";

import { t } from "../../../i18n";
import type { BudgetStatusResponse, ProviderQuotaWindowStatus } from "../../../../../src/lib/config/settings-types";
import { ProblemCallout } from "../../components/ProblemCallout";
import { Switch } from "../../components/Switch";
import type { Problem } from "../../problems";

import { formatRelative, formatWhen, windowTone, windowUsedFraction } from "./format";
import { type BudgetFormat } from "./hooks";
import { providerName } from "./labels";
import { Meter } from "./Meter";

interface SettingsProps {
  status: BudgetStatusResponse | null;
  format: BudgetFormat | null;
  onSetEnabled: (enabled: boolean) => Promise<Problem | null>;
  onSetUnit: (unit: BudgetStatusResponse["display"]["unit"]) => Promise<Problem | null>;
}

/** One provider's windows, grouped under its name: "GitHub Copilot". */
function groupByProvider(
  windows: ReadonlyArray<ProviderQuotaWindowStatus>,
): Array<[string, Array<ProviderQuotaWindowStatus>]> {
  const groups = new Map<string, Array<ProviderQuotaWindowStatus>>();
  for (const window of windows) {
    groups.set(window.provider, [...(groups.get(window.provider) ?? []), window]);
  }
  return [...groups.entries()];
}

function WindowRow({ window, format }: { window: ProviderQuotaWindowStatus; format: BudgetFormat }): JSX.Element {
  const used = windowUsedFraction(window);
  const resetsAtMs = window.resets_at ? Date.parse(window.resets_at) : Number.NaN;
  const hasReset = !Number.isNaN(resetsAtMs);
  const percentUsed = used === null ? null : t("budget-window-used", { fraction: used });
  const over = window.overage?.used !== null && window.overage?.used !== undefined && window.overage.used > 0;
  return (
    <li className="budget-window">
      <div className="budget-window__head">
        <span className="budget-window__label">{window.label}</span>
        {percentUsed && <span className="budget-window__used">{percentUsed}</span>}
      </div>
      {used !== null && (
        <Meter
          fraction={used}
          tone={windowTone(used)}
          label={window.label}
          valueText={percentUsed ?? ""}

        />
      )}
      <p className="budget-window__note">
        {hasReset ?
          t("budget-window-resets", {
            date: formatWhen(resetsAtMs, format.now, format.locale),
            relative: formatRelative(resetsAtMs, format.now, format.locale),
          })
        : t("budget-window-no-reset")}
        {over && (
          <>
            {" · "}
            <span className="budget-window__over">{t("budget-window-over")}</span>
          </>
        )}
      </p>
    </li>
  );
}

/**
 * Settings: whether limits are enforced, the unit amounts are shown in, and
 * what each provider says about its own allowance and when it resets. The
 * provider's figures are context (they lag); limits count what Maximal records.
 * It comes after the limits and the activity people open the window for; the
 * summary at the top keeps the switch's state in view meanwhile.
 */
export function Settings({ status, format, onSetEnabled, onSetUnit }: SettingsProps): JSX.Element | null {
  const [saveProblem, setSaveProblem] = useState<Problem | null>(null);
  const [saving, setSaving] = useState(false);

  const run = async (change: () => Promise<Problem | null>): Promise<void> => {
    setSaving(true);
    setSaveProblem(await change());
    setSaving(false);
  };

  if (!status) return null;
  const windows = status.provider_windows;

  return (
    <section className="budget-block" aria-labelledby="budget-settings-title">
      <header className="section__head">
        <h2 className="budget-block__title" id="budget-settings-title">
          {t("budget-settings-title")}
        </h2>
        <p className="section__sub">{t("budget-settings-sub")}</p>
      </header>

      {saveProblem && <ProblemCallout problem={saveProblem} />}

      <div className="form">
        <div className="form__row">
          <div className="form__label">
            <label htmlFor="budget-enforce">{t("budget-enforce-label")}</label>
            <p className="form__hint">{t("budget-enforce-hint")}</p>
          </div>
          <div className="form__control">
            <Switch
              id="budget-enforce"
              checked={status.enabled}
              disabled={saving}
              label={t("budget-enforce-label")}
              hideLabel
              onCheckedChange={(next) => void run(() => onSetEnabled(next))}
            />
          </div>
        </div>
        <div className="form__row">
          <div className="form__label">
            <label htmlFor="budget-unit">{t("budget-unit-label")}</label>
            <p className="form__hint">{t("budget-unit-hint")}</p>
          </div>
          <div className="form__control">
            <select
              id="budget-unit"
              className="select"
              value={status.display.unit}
              disabled={saving}
              onChange={(event) => void run(() => onSetUnit(event.target.value === "credits" ? "credits" : "usd"))}
            >
              <option value="usd">{t("budget-unit-usd")}</option>
              <option value="credits">{t("budget-unit-credits")}</option>
            </select>
          </div>
        </div>
      </div>

      {format && (
        <div className="subsection">
          <h3 className="subsection__title">{t("budget-windows-title")}</h3>
          <p className="form__hint">{t("budget-windows-hint")}</p>
          {windows.length === 0 ?
            <p className="panel-status">{t("budget-windows-empty")}</p>
          : groupByProvider(windows).map(([provider, rows]) => (
              <div className="budget-provider" key={provider}>
                <h4 className="budget-provider__name">{providerName(provider)}</h4>
                <ul className="budget-windows">
                  {rows.map((window) => (
                    <WindowRow key={`${window.provider}:${window.id}`} window={window} format={format} />
                  ))}
                </ul>
              </div>
            ))
          }
        </div>
      )}
    </section>
  );
}
