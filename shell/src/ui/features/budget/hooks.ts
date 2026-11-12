import { useMemo, useEffect, useState } from "react";

import { resolveLocale, t } from "../../../i18n";

import { type DisplayInfo, formatAmount, nanoToDisplay } from "./format";

/** The active UI locale; re-renders when the language picker changes it
 *  (main.ts dispatches `maximal:locale-changed` after repainting). */
export function useLocale(): string {
  const [locale, setLocale] = useState(resolveLocale);
  useEffect(() => {
    const onChange = (): void => setLocale(resolveLocale());
    window.addEventListener("maximal:locale-changed", onChange);
    return () => window.removeEventListener("maximal:locale-changed", onChange);
  }, []);
  return locale;
}

/** The current time, refreshed every `intervalMs`, so "resets in 3 hours" stays true. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** What every part of the window needs to write an amount or a time. */
export interface BudgetFormat {
  locale: string;
  now: number;
  display: DisplayInfo;
  /** An amount already in the display unit, with its unit: "$2.40" or "2.4 credits". */
  money: (value: number) => string;
  /** A nano-AIU figure in the display unit. */
  nanoMoney: (nanoAiu: number) => string;
}

/** Build the format helpers for one display unit, locale and moment. */
export function useBuiltFormat(display: DisplayInfo, locale: string, now: number): BudgetFormat {
  return useMemo(() => {
    const money = (value: number): string => {
      const text = formatAmount(value, display.unit, locale);
      return display.unit === "usd" ? text : t("budget-amount-credits", { n: value, amount: text });
    };
    return {
      locale,
      now,
      display,
      money,
      nanoMoney: (nanoAiu) => money(nanoToDisplay(nanoAiu, display)),
    };
  }, [display, locale, now]);
}
