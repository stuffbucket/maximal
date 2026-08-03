# Clipping a rotating word without breaking the baseline

The rolodex reel on `/for-design-teams` cycles a word inside a sentence:
"So keep using **opencode**". The lead and the rotating word share one
baseline, so the block reads as a sentence rather than three stacked objects.

Two things in `site/src/pages/for-design-teams.astro` look wrong and are not.
Both cost a while to find, so they are written down here.

## Clip with `clip-path`, not `overflow`

An element with `overflow` set to anything other than `visible` is a scroll
container, and a scroll container synthesizes its baseline from the bottom of
its box rather than from its text. With `overflow: hidden` the rotating word
sits a descender low, and the line stops reading as a sentence.

`clip-path` clips without creating a scroll container, so the baseline stays
where the text puts it.

## The clip is inset, and by more at the top

A `1.12em` line box at a clamped font size never lands on a whole device pixel.
The rounding error accumulates down the list, so the item above bleeds a
hairline into the top of the frame. `inset(2px 0 1px)` covers it.

A 1px inset was not enough. `reel-clip-bleed.png` is that hairline, magnified.

## Reference images

Nothing here is served or bundled. These exist so a later reader can see what
the change looked like without rebuilding the page.

| File | What it shows |
| --- | --- |
| `assets/reel-inline-wide.png` | The result at 1440px, on the `opencode` turn. |
| `assets/reel-inline-narrow.png` | The same block at 520px. The word stays on the line. |
| `assets/reel-clip-bleed.png` | Why the clip is inset. Magnified top edge, showing a hairline of the previous word. |
| `assets/reel-clip-edges-clean.png` | The top edge on all six turns after the fix. No bleed. |

`opencode` is the worst case for the bottom edge, because it is the only item
with a descender. `reel-inline-wide.png` is on that turn on purpose.
