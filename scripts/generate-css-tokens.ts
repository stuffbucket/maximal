import { writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  fontStacks, text, weight, leading, tracking, spacing, radii, borderWidth, size,
  elevation, brand, accent, focusRing, layout, themes
} from "../shell/src/ui/styles/theme";

const REPO = resolve(import.meta.dir, "..");

function toKebabCase(str: string): string {
  return str.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

function processGroup(prefix: string, group: Record<string, string>): string[] {
  return Object.entries(group).map(([k, v]) => {
    // If the group is flat like 'brand.color' we might map it to --brand, 
    // or --brand-fg.
    const key = k === "color" 
      ? `--${prefix}` 
      : `--${prefix}-${toKebabCase(k)}`;
    return `  ${key}: ${v};`;
  });
}

type ThemeColors = Record<string, string>;

function declarations(colors: ThemeColors, indent: string): string[] {
  return Object.entries(colors).map(([k, v]) => `${indent}--${toKebabCase(k)}: ${v};`);
}

/**
 * The theme-dependent color blocks, identical in both outputs:
 *   - dark is the default (`:root`);
 *   - the OS light appearance switches to light, unless <html> is pinned
 *     with data-theme="dark";
 *   - data-theme="light" pins light regardless of the OS.
 * `color-scheme` rides along so native controls (selects, scrollbars,
 * checkboxes before styling) match the theme.
 */
function themeBlocks(dark: ThemeColors, light: ThemeColors): string[] {
  const darkKeys = Object.keys(dark).sort().join(",");
  const lightKeys = Object.keys(light).sort().join(",");
  if (darkKeys !== lightKeys) {
    throw new Error(
      `themes.dark and themes.light must declare the same colors.\n  dark:  ${darkKeys}\n  light: ${lightKeys}`,
    );
  }
  return [
    "/* ---- Theme colors ----",
    "   Dark by default; follows the OS when its appearance is light; a",
    "   data-theme=\"dark\" | \"light\" attribute on <html> pins either one. */",
    ":root {",
    "  color-scheme: dark;",
    ...declarations(dark, "  "),
    "}",
    "",
    "@media (prefers-color-scheme: light) {",
    "  :root:not([data-theme=\"dark\"]) {",
    "    color-scheme: light;",
    ...declarations(light, "    "),
    "  }",
    "}",
    "",
    "[data-theme=\"light\"] {",
    "  color-scheme: light;",
    ...declarations(light, "  "),
    "}",
  ];
}

function generateTokensCSS(): string {
  const rootLines: string[] = [
    "/* AUTO-GENERATED FROM shell/src/ui/styles/theme.ts */",
    "/* Design tokens — declared values for the shell (Settings window). */",
    "",
    ":root {"
  ];

  rootLines.push("  /* ---- Font stacks ---- */");
  Object.entries(fontStacks).forEach(([k, v]) => rootLines.push(`  --font-${k}: ${v};`));

  rootLines.push("\n  /* ---- Type ramp ---- */");
  Object.entries(text).forEach(([k, v]) => rootLines.push(`  --text-${k}: ${v};`));
  Object.entries(weight).forEach(([k, v]) => rootLines.push(`  --weight-${k}: ${v};`));
  Object.entries(leading).forEach(([k, v]) => rootLines.push(`  --leading-${k}: ${v};`));
  if (Object.keys(tracking).length > 0) {
    Object.entries(tracking).forEach(([k, v]) => rootLines.push(`  --tracking-${k}: ${v};`));
  }

  rootLines.push("\n  /* ---- Spacing ---- */");
  Object.entries(spacing).forEach(([k, v]) => rootLines.push(`  --space-${k}: ${v};`));

  rootLines.push("\n  /* ---- Radii ---- */");
  Object.entries(radii).forEach(([k, v]) => rootLines.push(`  --radius-${k}: ${v};`));

  rootLines.push("\n  /* ---- Border widths ---- */");
  Object.entries(borderWidth).forEach(([k, v]) => rootLines.push(`  --border-width-${k}: ${v};`));

  rootLines.push("\n  /* ---- Sizing ---- */");
  Object.entries(size).forEach(([k, v]) => rootLines.push(`  --size-${k}: ${v};`));

  rootLines.push("\n  /* ---- Elevation ---- */");
  Object.entries(elevation).forEach(([k, v]) => rootLines.push(`  --elevation-${k}: ${v};`));

  rootLines.push("\n  /* ---- Colors ---- */");
  rootLines.push(...processGroup("brand", brand as any));
  const { destructive, destructiveFg, ...accentBase } = accent;
  rootLines.push(...processGroup("accent", accentBase as any));
  rootLines.push(`  --accent-destructive: ${destructive};`);
  rootLines.push(`  --accent-destructive-foreground: ${destructiveFg};`);
  
  rootLines.push("\n  /* ---- Focus ring ---- */");
  rootLines.push(`  --focus-ring-width: ${focusRing.width};`);
  rootLines.push(`  --focus-ring-offset: ${focusRing.offset};`);
  rootLines.push(`  --focus-ring-color: ${focusRing.color};`);
  rootLines.push(`  --focus-ring: ${focusRing.expr};`);

  rootLines.push("\n  /* ---- Layout constants ---- */");
  Object.entries(layout).forEach(([k, v]) => rootLines.push(`  --${toKebabCase(k)}: ${v};`));

  rootLines.push("}\n");

  rootLines.push(...themeBlocks(themes.dark, themes.light), "");

  return rootLines.join("\n");
}

const DASHBOARD_BEGIN = "/* ---- BEGIN GENERATED TOKENS (scripts/generate-css-tokens.ts) ---- */";
const DASHBOARD_END = "/* ---- END GENERATED TOKENS ---- */";

function updateUsageViewerCss() {
  const cssPath = resolve(REPO, "shell/ui/dashboard/style.css");
  let cssSrc = readFileSync(cssPath, "utf8");

  // We only replace the :root { ... } block for the dashboard.
  // The dashboard needs fewer things but it's safe to give it all the tokens.
  const rootLines: string[] = [
    ":root {"
  ];
  
  rootLines.push("  /* ---- Font stacks ---- */");
  Object.entries(fontStacks).forEach(([k, v]) => rootLines.push(`  --font-${k}: ${v};`));

  rootLines.push("");
  rootLines.push("  /* Auto-injected tokens */");
  Object.entries(text).forEach(([k, v]) => rootLines.push(`  --text-${k}: ${v};`));
  Object.entries(weight).forEach(([k, v]) => rootLines.push(`  --weight-${k}: ${v};`));
  Object.entries(leading).forEach(([k, v]) => rootLines.push(`  --leading-${k}: ${v};`));
  Object.entries(tracking).forEach(([k, v]) => rootLines.push(`  --tracking-${k}: ${v};`));
  Object.entries(spacing).forEach(([k, v]) => rootLines.push(`  --space-${k}: ${v};`));
  Object.entries(radii).forEach(([k, v]) => rootLines.push(`  --radius-${k}: ${v};`));
  Object.entries(borderWidth).forEach(([k, v]) => rootLines.push(`  --border-width-${k}: ${v};`));
  Object.entries(size).forEach(([k, v]) => rootLines.push(`  --size-${k}: ${v};`));
  Object.entries(elevation).forEach(([k, v]) => rootLines.push(`  --elevation-${k}: ${v};`));

  rootLines.push(...processGroup("brand", brand as any));
  const { destructive, destructiveFg, ...accentBase } = accent;
  rootLines.push(...processGroup("accent", accentBase as any));
  rootLines.push(`  --accent-destructive: ${destructive};`);
  rootLines.push(`  --accent-destructive-foreground: ${destructiveFg};`);
  rootLines.push(`  --focus-ring: ${focusRing.dashboardExpr};`);
  Object.entries(layout).forEach(([k, v]) => rootLines.push(`  --${toKebabCase(k)}: ${v};`));
  
  rootLines.push("}");
  rootLines.push("");
  rootLines.push(
    ...themeBlocks(themes.dark, themes.light),
  );

  const generated = [DASHBOARD_BEGIN, ...rootLines, DASHBOARD_END].join("\n");
  const begin = cssSrc.indexOf(DASHBOARD_BEGIN);
  const end = cssSrc.indexOf(DASHBOARD_END);
  let nextSrc: string;
  if (begin !== -1 && end !== -1) {
    nextSrc = cssSrc.slice(0, begin) + generated + cssSrc.slice(end + DASHBOARD_END.length);
  } else {
    // First run on a file without markers: replace its single :root block.
    const regex = /:root\s*\{[^}]+\}/m;
    if (!regex.test(cssSrc)) throw new Error("dashboard style.css has no :root block or token markers");
    nextSrc = cssSrc.replace(regex, generated);
  }
  writeFileSync(cssPath, nextSrc, "utf8");
}

const tokensContent = generateTokensCSS();
writeFileSync(resolve(REPO, "shell/src/ui/styles/tokens.css"), tokensContent, "utf8");
updateUsageViewerCss();
console.log("Tokens synchronized strictly from typescript source.");
