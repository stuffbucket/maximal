/**
 * How long after a dialog opens the rest of the double click that opened it
 * can still arrive. Generous next to platform double-click intervals, short
 * next to the time it takes to read a dialog.
 */
export const TRAILING_CLICK_MS = 500;

/**
 * Whether a click inside a just-opened dialog is the trailing click of the
 * multi-click gesture that opened it (`detail` is the click count). Such a
 * click must neither dismiss the dialog through its backdrop nor press one
 * of its buttons. Single clicks and keyboard activation (`detail` 0 or 1)
 * always count, and so does a later deliberate double click.
 */
export function isTrailingClickOfOpening(
  clickCount: number,
  msSinceOpen: number,
): boolean {
  return clickCount > 1 && msSinceOpen < TRAILING_CLICK_MS;
}
