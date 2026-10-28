// Pure geometry for the Dashboard's live card: the trace paths and the
// chasing border's speed. No DOM, so the root test suite can import it.

export interface Trace {
  /** The smoothed line, as an SVG path. */
  line: string;
  /** The line closed down to the baseline, for the gradient fill. */
  area: string;
  /** The latest point, where the dot sits. */
  last: [number, number];
}

/** Two decimals is well under a device pixel; "-0" reads as "0". */
function fmt(n: number): string {
  const r = Math.round(n * 100) / 100;
  return String(r === 0 ? 0 : r);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Fritsch–Carlson tangents for evenly spaced points: a monotone cubic, so the
 * curve never swings past a neighbouring value (no dip below zero after a
 * spike, no peak above the busiest minute).
 */
function monotoneTangents(ys: Array<number>, step: number): Array<number> {
  const n = ys.length;
  const d = Array.from({ length: n - 1 }, (_, i) => (ys[i + 1] - ys[i]) / step);
  const m = ys.map((_, i) => {
    if (i === 0) return d[0];
    if (i === n - 1) return d[n - 2];
    return d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  });
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      m[i] = tau * a * d[i];
      m[i + 1] = tau * b * d[i];
    }
  }
  return m;
}

/**
 * One session's trace in a `width` × `height` box, oldest value at x = 0 and
 * the latest at x = width. A value of `max` touches the top; 0 sits on the
 * baseline (y = height). Values are clamped to [0, max], and so is every
 * control point, so no part of the path leaves the box.
 */
export function tracePath(
  values: Array<number>,
  max: number,
  width: number,
  height: number,
): Trace {
  const scale = max > 0 ? max : 1;
  const ys = values.map((v) => height - clamp(v / scale, 0, 1) * height);
  if (ys.length === 0) ys.push(height);
  if (ys.length === 1) {
    const y = fmt(ys[0]);
    const line = `M0,${y} L${fmt(width)},${y}`;
    return {
      line,
      area: `${line} L${fmt(width)},${fmt(height)} L0,${fmt(height)} Z`,
      last: [width, ys[0]],
    };
  }

  const step = width / (ys.length - 1);
  const m = monotoneTangents(ys, step);
  const parts = [`M0,${fmt(ys[0])}`];
  for (let i = 0; i < ys.length - 1; i++) {
    const x0 = i * step;
    const x1 = (i + 1) * step;
    const c1y = clamp(ys[i] + (m[i] * step) / 3, 0, height);
    const c2y = clamp(ys[i + 1] - (m[i + 1] * step) / 3, 0, height);
    parts.push(
      `C${fmt(x0 + step / 3)},${fmt(c1y)} ${fmt(x1 - step / 3)},${fmt(c2y)} ${fmt(x1)},${fmt(ys[i + 1])}`,
    );
  }
  const line = parts.join(" ");
  return {
    line,
    area: `${line} L${fmt(width)},${fmt(height)} L0,${fmt(height)} Z`,
    last: [width, ys[ys.length - 1]],
  };
}

const SLOWEST_S = 30;
const FASTEST_S = 4;
/** Tokens/min where the log scale's knee sits, and where it reaches 4 s. */
const KNEE = 500;
const TOP = 100_000;

/**
 * Seconds per turn of the chasing border for the whole system's tokens/min:
 * none at 0 (stopped), about 30 s for a trickle, down to 4 s from 100,000
 * tokens/min, on a log scale.
 */
export function borderPeriodS(flowPerMin: number): number | null {
  if (!Number.isFinite(flowPerMin) || flowPerMin <= 0) return null;
  const t = Math.log10(1 + flowPerMin / KNEE) / Math.log10(1 + TOP / KNEE);
  return clamp(SLOWEST_S - (SLOWEST_S - FASTEST_S) * t, FASTEST_S, SLOWEST_S);
}
