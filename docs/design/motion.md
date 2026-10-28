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

## The live border

The Dashboard's live card has one continuous animation: its hairline
border, a conic sweep of `--accent` over `--border-subtle`, turning
through the registered angle `--live-angle` (`live-border-spin`). It
carries information: its speed follows token flow across the whole
system.

- No flow: stopped (`animation-play-state: paused`).
- A trickle: about 30 s per turn. From 100,000 tokens/min: 4 s per turn.
  Between them the speed follows a log scale
  (`borderPeriodS` in `shell/src/dashboard/live/geometry.ts`).
- Changes of speed ease over 3 s. The speed is the animation's
  `playbackRate`, not its duration, so the angle never jumps when the
  flow changes.
- Beside it, the "Live" marker's dot pings (`live-pulse`, 2 s) while
  tokens flow, and not otherwise. It loops too, so the same rule applies.

Other Dashboard movement is short and finite: the traces, dots and
figure glide to each poll's values over 900 ms.

Under `prefers-reduced-motion: reduce` the border does not rotate, even
slowly: `.live--border` and the pulse get `animation: none`, and the
card's script skips the glide and sets values and speed directly. The
border stays drawn at its resting angle. Don't make that a slower
rotation.

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
