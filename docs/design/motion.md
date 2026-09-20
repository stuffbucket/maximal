# Motion

**Motion is utility, not delight.** Delight comes from typography,
spacing, and copy.

## Timings

- **150ms ease-out** — default for hover/active state changes.
- **200ms ease-out** — layout shifts (window resize, card collapse,
  switch toggle).
- **0ms (instant)** — under `prefers-reduced-motion: reduce`, except
  a single 60ms opacity crossfade where a transition would otherwise
  be jarring.

## What's forbidden

- No bounce / spring / elastic curves.
- No parallax.
- No hover scales above 1.0 → 1.02. (Generally: no hover scales at all.)
- No staggered cascade animations (the "AI-dashboard reveal" pattern).

## Reduced-motion contract

When `prefers-reduced-motion: reduce` is set:

- All hover scales → off.
- All slide-ins / fade-up / translate animations → off (substitute a
  60ms opacity crossfade if the user would otherwise see a jarring
  instant change).
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
  .thing,
  .thing * {
    transition-duration: 0ms !important;
    animation-duration: 0ms !important;
  }
}
```

A single global `prefers-reduced-motion` block at the bottom of
`styles.css` is preferred over per-component opt-ins (less to forget).
