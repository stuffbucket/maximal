/**
 * WCAG contrast for the design tokens, per theme — the shared core of
 * scripts/contrast-audit.ts (CLI) and the Foundations/Contrast story.
 * Browser-safe: reads token values from theme.ts, no DOM, no node:*.
 */
import { accent, brand, themes } from "../../../shell/src/ui/styles/theme";

export type Theme = keyof typeof themes;
type Colors = Record<string, string>;

// ---- color math (WCAG 2.x relative luminance) -------------------------------
function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// ---- the roles each token plays ---------------------------------------------
/** Resolve a token name to its value in a theme. */
export function value(theme: Theme, token: string): string {
  const all: Colors = {
    ...Object.fromEntries(Object.entries(themes[theme]).map(([k, v]) => [kebab(k), v])),
    brand: brand.color,
    "accent-fg": accent.fg,
    "accent-destructive": accent.destructive,
    "accent-destructive-foreground": accent.destructiveFg,
  };
  const v = all[token];
  if (!v) throw new Error(`unknown token --${token}`);
  return v;
}

function kebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

export const SURFACES = ["surface-base", "surface-card", "surface-control"];

/** [token, role, why] — the role is what the UI actually uses it for. */
export const ROLES: Array<[string, "text" | "non-text", string]> = [
  ["text-strong", "text", "headings, primary text"],
  ["text-base-color", "text", "body text"],
  ["text-muted", "text", "captions, helpers"],
  ["link", "text", "links and all teal text (\"Copied\", accent figures)"],
  ["link-hover", "text", "hovered links"],
  ["status-error", "text", "error text, destructive ghost buttons"],
  ["status-success", "text", "success text, connected indicator"],
  ["status-warning", "text", "warning text, degraded indicator"],
  ["status-info", "text", "info figures"],
  ["accent", "non-text", "switch on, checkbox fill, focus ring, busy bar"],
  ["brand", "non-text", "requirement-callout stripe and icon"],
  ["border-strong", "non-text", "input and checkbox borders"],
  ["status-error", "non-text", "error stripes and icons"],
  ["status-warning", "non-text", "warning icons"],
];

/** [label text, fill] pairs. */
export const ON_FILL: Array<[string, string, string]> = [
  ["accent-fg", "accent", "primary button label"],
  ["accent-destructive-foreground", "accent-destructive", "destructive button label"],
];

export interface Check {
  theme: Theme;
  fg: string;
  bg: string;
  role: string;
  why: string;
  ratio: number;
  min: number;
}

export function matrix(): Array<Check> {
  const out: Array<Check> = [];
  for (const theme of Object.keys(themes) as Array<Theme>) {
    for (const [token, role, why] of ROLES) {
      for (const surface of SURFACES) {
        const ratio = contrast(value(theme, token), value(theme, surface));
        out.push({ theme, fg: token, bg: surface, role, why, ratio, min: role === "text" ? 4.5 : 3 });
      }
    }
    for (const [fg, bg, why] of ON_FILL) {
      out.push({ theme, fg, bg, role: "on-fill", why, ratio: contrast(value(theme, fg), value(theme, bg)), min: 4.5 });
    }
  }
  return out;
}

