import { t } from "../../../i18n";

import { type RangeChoice, type RangeKind, RANGE_PRESETS, type RangePreset, customSpan } from "./range";

interface RangePickerProps {
  /** Prefix for the ids of the date fields, so two pickers on a page don't share them. */
  id: string;
  value: RangeChoice;
  onChange: (next: RangeChoice) => void;
  /** Which named ranges to offer; all of them by default. */
  presets?: ReadonlyArray<RangePreset>;
  /** Offer a custom pair of days. On by default. */
  custom?: boolean;
  disabled?: boolean;
}

/** What a range option reads as: "24 hours", "7 days", "All time", "Custom". */
export function rangeLabel(kind: RangeKind): string {
  switch (kind) {
    case "24h":
      return t("budget-range-hours", { n: 24 });
    case "7d":
      return t("dashboard-period-days", { n: 7 });
    case "30d":
      return t("dashboard-period-days", { n: 30 });
    case "90d":
      return t("dashboard-period-days", { n: 90 });
    case "all":
      return t("budget-range-all");
    case "custom":
      return t("budget-range-custom");
  }
}

/**
 * How far back to look: a segmented row of named ranges (the Dashboard's
 * pattern, with more of them) and, under Custom, two day fields. Days are UTC,
 * like everything the API counts, and the second is the last day included. A
 * range that runs backwards says so under the fields and asks for nothing.
 */
export function RangePicker({ id, value, onChange, presets = RANGE_PRESETS, custom = true, disabled = false }: RangePickerProps): JSX.Element {
  const kinds: Array<RangeKind> = custom ? [...presets, "custom"] : [...presets];
  const backwards = value.range === "custom" && value.from !== "" && value.to !== "" && customSpan(value) === null;
  return (
    <div className="range-picker">
      <div className="range-seg" role="group" aria-label={t("budget-range-label")}>
        {kinds.map((kind) => (
          <button
            key={kind}
            type="button"
            className="range-seg__option"
            aria-pressed={value.range === kind}
            disabled={disabled}
            onClick={() => onChange({ ...value, range: kind })}
          >
            {rangeLabel(kind)}
          </button>
        ))}
      </div>
      {value.range === "custom" && (
        <div className="range-picker__custom">
          <div className="budget-field budget-field--inline">
            <label htmlFor={`${id}-from`}>{t("budget-range-from")}</label>
            <input
              id={`${id}-from`}
              type="date"
              className="input range-picker__date"
              value={value.from}
              max={value.to || undefined}
              aria-invalid={backwards || undefined}
              disabled={disabled}
              onChange={(event) => onChange({ ...value, from: event.target.value })}
            />
          </div>
          <div className="budget-field budget-field--inline">
            <label htmlFor={`${id}-to`}>{t("budget-range-to")}</label>
            <input
              id={`${id}-to`}
              type="date"
              className="input range-picker__date"
              value={value.to}
              min={value.from || undefined}
              aria-invalid={backwards || undefined}
              disabled={disabled}
              onChange={(event) => onChange({ ...value, to: event.target.value })}
            />
          </div>
          {backwards && (
            <p className="budget-field__error" role="alert">
              {t("budget-range-backwards")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
