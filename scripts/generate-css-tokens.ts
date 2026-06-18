import { writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  fontStacks, text, weight, leading, tracking, spacing, radii, borderWidth, size,
  elevation, brand, accent, status, link, focusRing, layout, themes
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
  const { hover, destructive, destructiveFg, ...accentBase } = accent;
  rootLines.push(...processGroup("accent", accentBase as any));
  rootLines.push(`  --accent-hover: ${hover};`);
  rootLines.push(`  --accent-destructive: ${destructive};`);
  rootLines.push(`  --accent-destructive-foreground: ${destructiveFg};`);
  
  rootLines.push("\n  /* ---- Semantic status ---- */");
  rootLines.push(...processGroup("status", status as any));

  rootLines.push("\n  /* ---- Link colors (defaults to dark theme) ---- */");
  rootLines.push(`  --link: ${link.dark.color};`);
  rootLines.push(`  --link-hover: ${link.dark.hover};`);

  rootLines.push("\n  /* ---- Focus ring ---- */");
  rootLines.push(`  --focus-ring-width: ${focusRing.width};`);
  rootLines.push(`  --focus-ring-offset: ${focusRing.offset};`);
  rootLines.push(`  --focus-ring-color: ${focusRing.color};`);
  rootLines.push(`  --focus-ring: ${focusRing.expr};`);

  rootLines.push("\n  /* ---- Layout constants ---- */");
  Object.entries(layout).forEach(([k, v]) => rootLines.push(`  --${toKebabCase(k)}: ${v};`));

  rootLines.push("}\n");

  const darkTheme = Object.entries(themes.dark).map(([k, v]) => `  --${toKebabCase(k)}: ${v};`).join("\n");
  rootLines.push(`[data-theme="dark"] {\n${darkTheme}\n}\n`);

  const lightTheme = Object.entries(themes.light).map(([k, v]) => `  --${toKebabCase(k)}: ${v};`).join("\n");
  rootLines.push(`[data-theme="light"] {\n${lightTheme}\n}\n`);

  return rootLines.join("\n");
}

function updateUsageViewerCss() {
  const cssPath = resolve(REPO, "src/pages/usage-viewer.css");
  let cssSrc = readFileSync(cssPath, "utf8");

  // We only replace the :root { ... } block for the dashboard.
  // The dashboard needs fewer things but it's safe to give it all the tokens.
  const rootLines: string[] = [
    ":root {"
  ];
  
  rootLines.push("  /* Font stacks. No --font-display */");
  rootLines.push(`  --font-body: ${fontStacks.body};`);
  rootLines.push(`  --font-mono: ${fontStacks.mono};`);
  
  rootLines.push("");
  rootLines.push("  /* Auto-injected tokens */");
  Object.entries(text).forEach(([k, v]) => rootLines.push(`  --text-${k}: ${v};`));
  Object.entries(weight).forEach(([k, v]) => rootLines.push(`  --weight-${k}: ${v};`));
  Object.entries(leading).forEach(([k, v]) => rootLines.push(`  --leading-${k}: ${v};`));
  Object.entries(tracking).forEach(([k, v]) => rootLines.push(`  --tracking-${k}: ${v};`));
  Object.entries(spacing).forEach(([k, v]) => rootLines.push(`  --space-${k}: ${v};`));
  Object.entries(radii).forEach(([k, v]) => rootLines.push(`  --radius-${k}: ${v};`));
  Object.entries(elevation).forEach(([k, v]) => rootLines.push(`  --elevation-${k}: ${v};`));
  
  rootLines.push(...processGroup("brand", brand as any));
  const { hover, destructive, destructiveFg, ...accentBase } = accent;
  rootLines.push(...processGroup("accent", accentBase as any));
  rootLines.push(`  --accent-hover: ${hover};`);
  rootLines.push(...processGroup("status", status as any));
  rootLines.push(`  --link: var(--accent);`);
  rootLines.push(`  --link-hover: var(--accent-hover);`);
  rootLines.push(`  --focus-ring: ${focusRing.dashboardExpr};`);
  
  const darkThemeLines = Object.entries(themes.dark).map(([k, v]) => {
     // Dashboard uses --surface-base for textMuted sometimes? We just provide the vars.
     return `  --${toKebabCase(k)}: ${v};`;
  });
  rootLines.push(...darkThemeLines);
  
  rootLines.push("");
  rootLines.push("  /* Legacy aliases maintained for usage-viewer */");
  rootLines.push(`  --color-bg-darkest: var(--surface-base);`);
  rootLines.push(`  --color-bg: var(--surface-card);`);
  rootLines.push(`  --color-bg-soft: var(--surface-card);`);
  rootLines.push(`  --color-bg-light-1: var(--surface-control);`);
  rootLines.push(`  --color-bg-light-2: var(--border-subtle);`);
  rootLines.push(`  --color-fg-dark: var(--text-muted);`);
  rootLines.push(`  --color-fg-medium: var(--text-base-color);`);
  rootLines.push(`  --color-fg-light: var(--text-base-color);`);
  rootLines.push(`  --color-fg-lightest: var(--text-strong);`);
  rootLines.push(`  --color-blue: var(--accent);`);
  rootLines.push(`  --color-blue-accent: var(--accent-hover);`);
  rootLines.push(`  --color-red: var(--status-error);`);
  rootLines.push(`  --color-red-accent: var(--status-error-fg);`);
  rootLines.push(`  --color-green: var(--status-success);`);
  rootLines.push(`  --color-green-accent: var(--status-success-fg);`);
  rootLines.push(`  --color-yellow: var(--status-warning);`);
  rootLines.push(`  --color-yellow-accent: var(--status-warning-fg);`);
  rootLines.push(`  --color-aqua-accent: var(--status-info-fg);`);
  rootLines.push(`  --color-purple-accent: #c084fc; /* specific to dashboard */`);
  rootLines.push(`  --color-gray: var(--text-muted);`);
  rootLines.push(`  --color-gray-accent: var(--text-muted);`);

  rootLines.push("}");
  
  // replace from `:root {` down to `}`
  const regex = /:root\s*\{[^}]+\}/m;
  const nextSrc = cssSrc.replace(regex, rootLines.join("\n"));
  writeFileSync(cssPath, nextSrc, "utf8");
}

const tokensContent = generateTokensCSS();
writeFileSync(resolve(REPO, "shell/src/ui/styles/tokens.css"), tokensContent, "utf8");
updateUsageViewerCss();
console.log("Tokens synchronized strictly from typescript source.");
