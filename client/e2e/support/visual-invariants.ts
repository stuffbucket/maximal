import type { Locator, Page } from '@playwright/test'

/**
 * Computed-style and geometry assertions for the packaged app's own chrome —
 * the class of defect two prior "everything measures fine" runs missed (see
 * the header comment in ../packaged-app.spec.ts): an unresolved `--shell-*`
 * custom property collapsing text to near-invisible or a focus outline to
 * `none`, and fixed-height chrome whose wrapped content overlaps or clips
 * instead of growing.
 *
 * Deliberately NOT a screenshot-diff baseline — this project has no baseline
 * infrastructure, and pixel diffs are brittle across fonts/DPI/OS. Every
 * function here reads the browser's OWN resolved computed style/geometry and
 * checks it against an invariant, so it fails on the actual defect class
 * rather than on incidental pixel drift.
 */

// ---------------------------------------------------------------------------
// Colour + contrast
// ---------------------------------------------------------------------------

interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

/** Parses a `getComputedStyle(...).color`-shaped string. Computed colour
 *  values are always normalized to `rgb(...)`/`rgba(...)` by the browser
 *  (never hex/named), so this is the only shape callers need to handle. */
function parseRgba(value: string): Rgba {
  const match = value.match(/rgba?\(([^)]+)\)/)
  if (!match) {
    // 'transparent' (some engines) or an unresolved value — treat as fully
    // transparent so it contributes nothing when compositing.
    return { r: 0, g: 0, b: 0, a: 0 }
  }
  const parts = match[1].split(',').map((part) => Number.parseFloat(part.trim()))
  const [r, g, b, a = 1] = parts
  return { r: r ?? 0, g: g ?? 0, b: b ?? 0, a: a ?? 1 }
}

function channelLuminance(channel255: number): number {
  const c = channel255 / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** WCAG 2.1 relative luminance (§1.4.3), 0 (black) to 1 (white). */
function relativeLuminance({ r, g, b }: Rgba): number {
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b)
}

/** WCAG 2.1 contrast ratio (§1.4.3) between two OPAQUE colours, 1:1 (no
 *  contrast) to 21:1 (black on white). Order-independent. */
function contrastRatio(a: Rgba, b: Rgba): number {
  const l1 = relativeLuminance(a)
  const l2 = relativeLuminance(b)
  const [lighter, darker] = l1 >= l2 ? [l1, l2] : [l2, l1]
  return (lighter + 0.05) / (darker + 0.05)
}

/**
 * Resolves an element's computed text colour and its EFFECTIVE (opaque)
 * background — composited from the element's own `background-color` down
 * through every ancestor up to `<html>`, rather than just reading the
 * element's own value.
 *
 * This matters here specifically: the package's "selected" states (e.g.
 * `.nav__item[aria-current='true']`, `.icon-button[data-active='true']`) are
 * painted with a TRANSLUCENT `--shell-accent-muted` background (see
 * `theme.ts`'s own comment: chosen at 0.12 alpha specifically so accent text
 * on top still clears 4.5:1). Reading that rgba string's R/G/B directly and
 * ignoring alpha would silently overstate contrast for exactly the controls
 * most worth checking. Compositing bottom-up over every ancestor (each layer
 * painted over the accumulated result, per the standard "over" alpha
 * operator) reproduces what a viewer actually sees, and matches the ratios
 * `theme.ts` documents for these pairs (verified against its "--shell-accent
 * on --shell-accent-muted 4.61:1" figure while building this helper).
 */
async function resolvedColors(locator: Locator): Promise<{ color: Rgba; background: Rgba }> {
  const raw = await locator.evaluate((el) => {
    const chain: string[] = []
    let node: Element | null = el
    while (node) {
      chain.push(getComputedStyle(node).backgroundColor)
      node = node.parentElement
    }
    return { color: getComputedStyle(el).color, backgroundChain: chain }
  })

  // Composite from the outermost ancestor (last in the chain) down to the
  // element's own background (first), so each layer paints OVER the
  // accumulated result underneath it — the same order the browser paints in.
  // The base behind <html> is opaque white: a real window always has SOME
  // opaque root paint, and white is the conservative choice (it only ever
  // UNDERSTATES how dark/low-contrast a translucent dark-on-dark stack reads,
  // never hides a real problem).
  let composite = { r: 255, g: 255, b: 255 }
  for (let i = raw.backgroundChain.length - 1; i >= 0; i--) {
    const layer = parseRgba(raw.backgroundChain[i])
    if (layer.a === 0) continue
    composite = {
      r: layer.r * layer.a + composite.r * (1 - layer.a),
      g: layer.g * layer.a + composite.g * (1 - layer.a),
      b: layer.b * layer.a + composite.b * (1 - layer.a),
    }
  }

  return {
    color: parseRgba(raw.color),
    background: { ...composite, a: 1 },
  }
}

/**
 * The "not near-invisible" floor used by `assertContrastAtLeast` below.
 *
 * 2.0:1 is chosen deliberately, not the WCAG AA figure (4.5:1) or AA-large
 * (3:1): `.design-context.md` principle 3 is "colour is the user's, contrast
 * is ours — warn at sub-AA, never block," and `theme.ts`'s own shipped
 * palette INTENTIONALLY includes a sub-AA pair (`--shell-text-subtle` on
 * `--shell-background`, documented there at 3.28:1) — a 4.5:1 gate would fail
 * that legitimate, deliberate choice. The historical defect this guards
 * against measured roughly 1.1:1 (near-black text on a near-black window —
 * effectively invisible). 2.0:1 sits strictly between the lowest ratio this
 * app ships on purpose (3.28:1) and the ratio that was actually broken
 * (~1.1:1): low enough to never fail a legitimate design choice already in
 * the codebase, high enough to catch the "no palette resolved at all" class
 * of failure this suite exists to catch.
 */
export const CONTRAST_FLOOR = 2.0

export async function assertContrastAtLeast(locator: Locator, label: string, minRatio = CONTRAST_FLOOR): Promise<void> {
  const { color, background } = await resolvedColors(locator)
  const ratio = contrastRatio(color, background)
  if (ratio < minRatio) {
    throw new Error(
      `${label}: contrast ratio ${ratio.toFixed(2)}:1 is below the ${minRatio}:1 floor ` +
        `(text ${JSON.stringify(color)} on effective background ${JSON.stringify(background)})`,
    )
  }
}

// ---------------------------------------------------------------------------
// Focus indicator
// ---------------------------------------------------------------------------

/**
 * Focuses `locator` and asserts the computed outline actually resolves to
 * something rendered — `outline-style` not `none`, and `outline-width` a
 * positive number of pixels. This is exactly the invariant the original bug
 * violated: `outline: 2px solid var(--shell-focus, var(--shell-accent))`
 * with neither custom property defined computes to `outline: none` at
 * computed-value time (CSS Custom Properties §3.2 — an invalid `var()` with
 * no usable fallback invalidates the whole declaration), so `outline-style`
 * resolves to its initial value, `none`, and there is no visible ring at all.
 *
 * Presses Tab first, deliberately. A bare `locator.focus()` calls the DOM
 * `focus()` method directly, and Chromium's `:focus-visible` heuristic keys
 * off the most recent input MODALITY, not the focus call itself: after this
 * suite's prior mouse clicks (e.g. switching a view tab), the modality is
 * "mouse", so a subsequent programmatic `.focus()` alone does NOT match
 * `:focus-visible` and the assertion would fail even with the fix correctly
 * in place. One `Tab` keypress flips the modality to "keyboard" first,
 * matching how a real keyboard user reaches the control — confirmed
 * empirically while building this helper (outline-style read 'none' without
 * the Tab press, 'solid' with it, on the identical markup).
 */
export async function assertFocusOutlineResolves(page: Page, locator: Locator, label: string): Promise<void> {
  await page.keyboard.press('Tab')
  await locator.focus()
  const outline = await locator.evaluate((el) => {
    const cs = getComputedStyle(el)
    return { style: cs.outlineStyle, width: cs.outlineWidth }
  })
  if (outline.style === 'none') {
    throw new Error(`${label}: outline-style resolved to 'none' — no focus indicator would render`)
  }
  const width = Number.parseFloat(outline.width)
  if (!(width > 0)) {
    throw new Error(`${label}: outline-width resolved to '${outline.width}' (not a positive pixel value)`)
  }
}

// ---------------------------------------------------------------------------
// Geometry: overlap + clipping
// ---------------------------------------------------------------------------

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

function verticalOverlap(a: Rect, b: Rect): boolean {
  return a.y < b.y + b.height && b.y < a.y + a.height
}

/**
 * Asserts that no two of `locators`' bounding rects overlap vertically —
 * the invariant a wrapped nav-rail label (or any sibling list rendered at a
 * fixed row height) violates when its second line draws over the row below
 * it. Locators not currently rendering anything (`boundingBox()` returns
 * `null` for a detached/hidden element) are skipped rather than failing —
 * this checks the elements that ARE on screen don't collide, not that a
 * fixed count of them exists (`toHaveCount`/similar already covers that
 * elsewhere).
 */
export async function assertNoVerticalOverlap(locators: readonly Locator[], label: string): Promise<void> {
  const rects: Rect[] = []
  for (const locator of locators) {
    const box = await locator.boundingBox()
    if (box) rects.push(box)
  }
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      if (verticalOverlap(rects[i], rects[j])) {
        throw new Error(
          `${label}: element ${i} ${JSON.stringify(rects[i])} overlaps element ${j} ${JSON.stringify(rects[j])} vertically`,
        )
      }
    }
  }
}

/**
 * Asserts `locator`'s bounding rect does not extend past the window's
 * bottom or right edge — the invariant a fixed-height container with
 * wrapped/overflowing content violates when the overflow gets cut off by the
 * window itself rather than by any scrollbar (so nothing about the element's
 * own `overflow` property would have caught it).
 *
 * Deliberately checked per ELEMENT, not just on a container: the original
 * statusbar bug had a container that was itself only 24px tall (nominally
 * "within the window") while its wrapped `<span>` children individually
 * extended past both the container's own box and the window's bottom edge.
 * Callers checking "is content clipped" should pass the CONTENT locators
 * (e.g. the statusbar's `span` children), not just the container.
 */
export async function assertWithinWindow(page: Page, locator: Locator, label: string, epsilonPx = 1): Promise<void> {
  const box = await locator.boundingBox()
  if (!box) throw new Error(`${label}: no bounding box (element not visible/rendered)`)
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
  if (box.y + box.height > viewport.height + epsilonPx) {
    throw new Error(
      `${label}: bottom edge ${(box.y + box.height).toFixed(1)}px exceeds window height ${viewport.height}px`,
    )
  }
  if (box.x + box.width > viewport.width + epsilonPx) {
    throw new Error(
      `${label}: right edge ${(box.x + box.width).toFixed(1)}px exceeds window width ${viewport.width}px`,
    )
  }
}
