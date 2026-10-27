# Motion

**Motion is utility, not delight.** Delight comes from typography,
spacing, and copy.

## Timings

- **150ms ease-out** — default for hover/active state changes.
- **200ms ease-out** — layout shifts (card collapse, accordion
  twirldown).
- **Instant** — under `prefers-reduced-motion: reduce`.

## What's forbidden

- No bounce / spring / elastic curves.
- No parallax.
- No hover scales above 1.0 → 1.02. (Generally: no hover scales at all.)
- No staggered cascade animations (the "AI-dashboard reveal" pattern).

## Reduced-motion contract

When `prefers-reduced-motion: reduce` is set:

- All hover scales → off.
- All slide-ins / fade-up / translate animations → off. Where
  stopping an animation would leave a broken state (the busy bar's
  sliding segment), replace it with a static equivalent.
- Spring physics → off.
- The setting is honored **literally**, not "with reduced intensity."

See [`principles.md`](principles.md) → Principle 5.

## Implementation pattern

```css
.thing {
  transition: background-color 150ms ease-out,
              border-color 150ms ease-out;
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    transition-duration: 0.001ms !important;
    animation-duration: 0.001ms !important;
  }
}
```

Each window's stylesheet has one global `prefers-reduced-motion` block
like this (`styles.css` → *Motion*; the Dashboard's `style.css`), which
is preferred over per-component opt-ins (less to forget). Add a
per-component block only when zeroing the duration isn't enough.
