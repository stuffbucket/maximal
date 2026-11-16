/** Pure crop math for the Storybook asset exporter (no DOM, so it is unit-testable). */

export interface AssetBounds {
  height: number;
  width: number;
  x: number;
  y: number;
}

/** The target's box and the page's scrollable extent, all in page CSS pixels. */
export interface CropTarget {
  bottom: number;
  left: number;
  pageHeight: number;
  pageWidth: number;
  right: number;
  top: number;
}

/**
 * Pad the target box, clamp the padding to the page (never the target itself,
 * so a fixed-position dialog taller than the document is not cut), and snap
 * outward to whole CSS pixels. The origin is clamped at 0 and the width is
 * derived from the clamped edges, so a target touching the page edge keeps its
 * true size instead of gaining phantom padding.
 */
export function cropBounds(target: CropTarget, padding: number): AssetBounds {
  const left = Math.floor(Math.max(0, target.left - padding));
  const top = Math.floor(Math.max(0, target.top - padding));
  const right = Math.ceil(Math.min(Math.max(target.pageWidth, target.right), target.right + padding));
  const bottom = Math.ceil(Math.min(Math.max(target.pageHeight, target.bottom), target.bottom + padding));
  return { x: left, y: top, width: right - left, height: bottom - top };
}
