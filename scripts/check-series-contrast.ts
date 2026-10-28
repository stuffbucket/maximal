#!/usr/bin/env bun
/**
 * Series-palette gate for the Dashboard's live card.
 *
 * Each `--series-n` token (shell/src/ui/styles/theme.ts) draws a session's
 * trace and its table swatch, so in both themes it must:
 *   - clear 3:1 against `--surface-card` (WCAG 1.4.11, graphics), and
 *   - keep its hue clear of `--status-error`, `--status-warning` and
 *     `--status-success`, so a trace never reads as a state
 *     (docs/design/color.md → Color in data).
 *
 *   bun scripts/check-series-contrast.ts
 *
 * Values may be hex, `oklch(L C H)` or `var(--token)` of another theme color.
 * Exits 1 if any color fails, or falls outside sRGB.
 */
import { themes } from "../shell/src/ui/styles/theme";

type Theme = keyof typeof themes;
type Rgb = [number, number, number];

const MIN_CONTRAST = 3;
/** Degrees of OKLCH hue a series color keeps from each status color. */
const STATUS_HUE_CLEARANCE = 30;
const STATUS_TOKENS = [
  "statusError",
  "statusWarning",
  "statusSuccess",
] as const;

// ---- color math -----------------------------------------------------------
const toLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;

/** Linear sRGB of an OKLCH color (Björn Ottosson's matrices). */
function oklchToLinear(l: number, c: number, h: number): Rgb {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l3 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m3 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s3 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  ];
}

function linearToOklch([r, g, b]: Rgb): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [
    L,
    Math.hypot(A, B),
    ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360,
  ];
}

/** Resolve a theme value to linear sRGB, following `var(--token)`. */
function resolve(theme: Theme, value: string): Rgb {
  const ref = /^var\(--([a-z0-9-]+)\)$/.exec(value);
  if (ref) {
    const key = Object.keys(themes[theme]).find((k) => kebab(k) === ref[1]);
    if (!key) throw new Error(`${theme}: unknown token --${ref[1]}`);
    return resolve(theme, themes[theme][key as keyof (typeof themes)[Theme]]);
  }
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    return [0, 2, 4].map((i) =>
      toLinear(Number.parseInt(hex[1].slice(i, i + 2), 16) / 255),
    ) as Rgb;
  }
  const oklch = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value);
  if (oklch) {
    return oklchToLinear(Number(oklch[1]), Number(oklch[2]), Number(oklch[3]));
  }
  throw new Error(`${theme}: can't read color "${value}"`);
}

function kebab(s: string): string {
  return s
    .replace(/([a-z])([0-9])/g, "$1-$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

const luminance = ([r, g, b]: Rgb): number =>
  0.2126 * r + 0.7152 * g + 0.0722 * b;

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const inGamut = (rgb: Rgb): boolean =>
  rgb.every((c) => c >= -1e-4 && c <= 1 + 1e-4);

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// ---- report ---------------------------------------------------------------
let failures = 0;
for (const theme of Object.keys(themes) as Array<Theme>) {
  const colors = themes[theme];
  const card = resolve(theme, colors.surfaceCard);
  const statusHues = STATUS_TOKENS.map(
    (t) => [t, linearToOklch(resolve(theme, colors[t]))[2]] as const,
  );
  const series = Object.keys(colors).filter((k) => /^series\d+$/.test(k));
  if (series.length === 0) {
    console.log(`✗ ${theme}: no --series-n tokens`);
    failures++;
    continue;
  }

  console.log(
    `\n${theme.toUpperCase()} (against --surface-card ${colors.surfaceCard})`,
  );
  for (const key of series) {
    const value = colors[key as keyof typeof colors];
    const rgb = resolve(theme, value);
    const ratio = contrast(rgb, card);
    const hue = linearToOklch(rgb)[2];
    const [nearest, nearestHue] = statusHues.reduce((a, b) =>
      hueDistance(hue, a[1]) <= hueDistance(hue, b[1]) ? a : b,
    );
    const clearance = hueDistance(hue, nearestHue);
    const problems = [
      ratio < MIN_CONTRAST ? `below ${MIN_CONTRAST}:1` : "",
      clearance < STATUS_HUE_CLEARANCE
        ? `hue within ${STATUS_HUE_CLEARANCE}° of --${kebab(nearest)}`
        : "",
      inGamut(rgb) ? "" : "outside sRGB",
    ].filter(Boolean);
    if (problems.length > 0) failures++;
    console.log(
      `${problems.length > 0 ? "✗" : "✓"} --${kebab(key)}  ${ratio.toFixed(2).padStart(5)}:1  hue ${hue.toFixed(0).padStart(3)}°  ${clearance.toFixed(0).padStart(3)}° from --${kebab(nearest)}  ${value}${problems.length > 0 ? `  (${problems.join(", ")})` : ""}`,
    );
  }
}

console.log(
  failures === 0
    ? `\nAll series colors clear ${MIN_CONTRAST}:1 on the card and keep ${STATUS_HUE_CLEARANCE}° from the status hues.`
    : `\n${failures} series color(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
