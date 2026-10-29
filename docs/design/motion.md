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

An infinite animation also needs its own `animation: none` there: the
global block only shortens durations (and sets the iteration count to
1), and a looping animation must end up static, not merely fast.

## Live token flow

The Dashboard's live graph moves token particles between model and session
positions. Its dedicated Web Worker owns the simulation and OffscreenCanvas
rendering; the webview thread only sends data snapshots and resizes. The graph
has no animated border, pulse, or separate “Live” ornament—the data itself is
the motion.

The worker caps rendering at 30 frames per second and pauses while the page is
hidden. Particles travel at constant speed, dwell only briefly at a rendezvous
point, then take the reciprocal edge back; input/cache traffic and output thus
read as an exchange rather than a pile. Poll snapshots update rates without
restarting particles already in flight.

Under `prefers-reduced-motion: reduce` the worker draws the current distribution
once and does not schedule animation frames. Don't replace that static state
with slower particles.

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
