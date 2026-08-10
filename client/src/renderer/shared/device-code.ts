// Shared "spell a device code out for assistive tech" helper. Both
// `first-run` and `settings` render the same GitHub device code and must
// announce it identically — see the task report for why rendering it as one
// contiguous string breaks screen readers, and why the two surfaces had
// drifted to spelling it out two different ways.

/** Spells a code out for assistive tech: "1234-ABCD" -> "1 2 3 4 dash A B C
 *  D", so a screen reader announces discrete characters instead of
 *  attempting to pronounce the code as one mangled word. Pair with an
 *  `aria-hidden` visual rendering of the raw code plus a visually-hidden
 *  text node carrying this spelled-out form — never an `aria-label` on a
 *  role-less element (a `<p>`, `<div>`, ...), which ARIA-in-HTML prohibits
 *  and browsers silently drop. */
export function spellOutCode(code: string): string {
  return code
    .split('')
    .map((char) => (char === '-' ? 'dash' : char))
    .join(' ')
}
