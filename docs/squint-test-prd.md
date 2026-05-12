# PRD: Automated squint test

## Problem

Contrast checks (axe-core, pa11y, WCAG ratio computation) tell you whether two adjacent colors *can* be told apart. They don't tell you whether a screen reads as a clear hierarchy. The classic designer move — defocus your eyes, see if hierarchy survives — has no automated equivalent in our stack.

Concrete cases the contrast checks miss:

- Three sections styled with identical card chrome on identical surface tone: contrast passes (text on card meets ratios) but visual hierarchy is flat. The eye has no anchor.
- A primary CTA the same size + weight as nearby secondary actions. Contrast passes; the page's primary action is invisible.
- A section heading at `--text-xl` weight 600 that lands ON the same surface color as the body. Technically passes; reads as "everything is equal."
- Activity-feed rows styled distinctively per the design but all clustering visually because they sit on identical card chrome at the same scale.

The human reviewer catches these in two seconds by squinting. We want an L3-tier automated check that catches the same class of failure.

## Goals

- Take a screenshot of any window in the design-tools workspace (or, later, the maximal Tauri shell).
- Apply a calibrated Gaussian blur (the "squint").
- Threshold + segment into connected luminance regions ("blobs").
- Report a structured verdict: blob count, dominant-blob luminance distribution, presence of a single visually dominant region.
- Fail when hierarchy is flat (single blob, or too many blobs of similar luminance).
- Stay container-bound (L3); never block the inner loop.

## Non-Goals

- **Replacing human review.** This catches the obvious failures. The "does it feel warm and crafted" question stays human.
- **True salience prediction.** We're not training a neural net; we're approximating the squint reflex. DeepGaze / SalGAN / similar belong in a separate, larger PRD.
- **Per-element hierarchy verdicts.** We're checking the screen as a whole, not annotating each component.
- **Replacing the LLM reviewer (L2).** The squint test is mechanical; the LLM reviewer reads prose/intent. They complement.

## How it works

Three stages, each cheap:

```
   screenshot.png
        │
        ▼  sharp .blur(σ=12)
   blurred.png
        │
        ▼  grayscale + adaptive threshold
   binary.png
        │
        ▼  connected-component labeling
   { blobs: [{bbox, area, meanLuminance}, ...] }
        │
        ▼  verdict rules
   { ok, score, reason }
```

**Stage 1 — Blur.** Gaussian blur with σ ≈ 12px at 1× DPI (24px at 2× retina). Calibrated empirically against the rule: the typeset body size (16px ≈ 1rem) should melt into uniform grayness; section headings (≥24px) should survive as distinct blocks. Configurable per call.

**Stage 2 — Threshold.** Convert to grayscale. Adaptive threshold (Otsu's method or local-mean) to convert continuous luminance into a binary mask. This is what "squinting" effectively does: collapses fine variation into bright/dark.

**Stage 3 — Segment.** Connected-components labeling. Output: list of distinct bright regions with bounding box, area, and mean luminance in the original (pre-threshold) blurred image.

## Verdict rules

Tunable; v1 ships with these defaults:

| Condition | Verdict | Reason |
|---|---|---|
| `blobs.length === 1` | **fail** | No hierarchy — screen reads as one undifferentiated wash. |
| `blobs.length >= 8` | **warn** | Possibly too busy — many distinct regions competing. May be fine for the dashboard's activity feed; flag for review. |
| `2 <= blobs.length <= 7` | **pass** (baseline) | Reasonable composition. |
| No single blob has `meanLuminance` more than `+15` (out of 255) above the second-brightest | **warn** | No clear visual anchor. Primary action may not stand out. |
| Largest blob area > 70% of screen | **warn** | One element dominates by area — possible accidental hero. Confirm intentional. |

`score` = `clamp(blob_count_score * primary_distinctness_score, 0, 1)`. Reported but not gating.

## API

A small TypeScript script in the design-tools workspace:

```ts
// scripts/squint.ts
export interface SquintResult {
  ok: boolean;
  score: number;          // 0..1
  blobs: Array<{
    bbox: [number, number, number, number]; // x, y, w, h
    area: number;
    meanLuminance: number;
  }>;
  reasons: string[];      // human-readable verdict breakdown
  artifacts: {
    blurredPath: string;
    binaryPath: string;
    overlayPath: string;  // original screenshot with blob bboxes drawn
  };
}

export async function squint(
  screenshotPath: string,
  options?: {
    sigma?: number;       // blur stddev in pixels, default 12
    minBlobArea?: number; // ignore noise below N px², default 200
    outputDir?: string;   // where to write artifacts, default same dir as input
  }
): Promise<SquintResult>;
```

Callable from Playwright tests, from `bun run` scripts, or as a CLI: `bun run squint <screenshot.png>`.

## Where it runs

**L3, in the existing design-tools container.** Reasons:

- `sharp` is already a Playwright peer-dep and lives natively in Node — no Python/OpenCV bridge needed.
- The screenshots come from Playwright runs that already run in the container.
- Latency is fine at L3 (~200–500ms per screenshot); not budget-fit for L1.

Run sites:
- Automatically appended to every `playwright` snapshot run — Playwright captures the screenshot, the test calls `squint(...)` on it, and the test fails if `ok === false`.
- Manually via `bun run squint path/to/image.png` for ad-hoc checks during iteration.

## Acceptance

Given a fresh `design-tools` workspace with the demo running, when the user runs:

```sh
bun run docker:playwright:squint
```

…the container spins up, Playwright opens `http://host.docker.internal:5173`, screenshots the demo, runs the squint analysis, and exits 0 with a printed verdict like:

```
src/components/card-demo.ts (1280×800)
  blobs:        4
  primary:      bbox=(160, 80, 360, 60)  meanLuminance=232
  separation:   +52 from next-brightest
  verdict:      PASS  (score 0.91)
  artifacts:    artifacts/2026-05-11T22-12-03.blurred.png
                artifacts/2026-05-11T22-12-03.binary.png
                artifacts/2026-05-11T22-12-03.overlay.png
```

Manual sanity tests:

1. **Flat screen test.** Mutate the demo to use the same `--surface-card` for every section. Re-run. Expect: `verdict: FAIL  (reason: blobs.length === 1)`.
2. **Primary-CTA-too-small test.** Drop the CTA font-size to `--text-xs`. Re-run. Expect: `verdict: WARN  (reason: no primary anchor; separation < 15)`.
3. **Busy-feed test.** Render 30 activity-feed rows. Re-run. Expect: `verdict: WARN  (reason: blob count ≥ 8)`. Confirm the warning fires, then confirm we can override the threshold via options for the activity feed specifically.

## Failure modes

- **Blob count is sensitive to σ.** Document the σ default and how to tune it per surface. If we ship a screenshot at 2× resolution and use the 1× σ, blob count balloons. Auto-scale σ by detected DPI.
- **Adaptive thresholding misbehaves on near-uniform images.** Fall back to a fixed threshold (e.g., 128) when the histogram is too narrow.
- **Overlay artifact path collisions** when many tests run in parallel. Suffix artifacts with a timestamp + test name.

## Calibration

Initial σ + thresholds are guesses. The PR that lands the script also includes a `calibrate.ts` helper that:

1. Renders a controlled grid of font sizes (8 / 10 / 12 / 14 / 16 / 18 / 24 / 32 / 48 px).
2. Runs squint at sigma = 4, 8, 12, 16, 20.
3. Reports: at each σ, the smallest font that survives as a distinct blob.
4. Lets us pick σ such that "body text (16px) melts; section headings (≥24px) survive."

Run once during setup; re-run if we change typefaces or surface contrast.

## Out of scope (revisit later)

- Salience-prediction heatmaps (DeepGaze / SalGAN). Heavier, model-dependent, real ML.
- Reading-flow analysis (F-pattern / Z-pattern). Mostly research code; oversells.
- Per-element annotation ("this label has X salience"). Different shape of tool.
- Color-blindness simulation. Cheap to add later; mostly a sharp-filter pipeline.

## Open questions

1. **σ default.** 12px works at 1× and 24px at 2×; landed via the calibrate script. Worth a follow-up if we add 3× targets.
2. **Per-window threshold overrides.** The Dashboard's activity feed legitimately has 10+ similar-luminance rows by design. Need a per-test config to relax the busy threshold there. Default lives in the script; per-test overrides via `squint(..., { thresholds: { ... } })`.
3. **Should the LLM reviewer see the squint output?** Yes — feed `SquintResult` into the L2 prompt context so the reviewer can ground "the layout looks off" claims in measurable signal. Cheap add; do after this lands.
4. **Visual regression interaction.** Playwright's `toHaveScreenshot` and squint can disagree: a screenshot can match the baseline pixel-for-pixel and still fail squint (if the baseline was flat). Document that squint catches *intent* drift; visual regression catches *render* drift. Both, not either.
