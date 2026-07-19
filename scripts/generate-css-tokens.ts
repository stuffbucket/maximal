import { writeFileSync, readFileSync, existsSync } from "node:fs";
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


const OUT_PATH = resolve(REPO, "shell/src/ui/styles/tokens.css");
const tokensContent = generateTokensCSS();

// `--check` verifies the committed CSS is a fresh generation of theme.ts
// without writing. This is the single-source enforcement gate: if theme.ts
// changed but tokens.css wasn't regenerated (or tokens.css was hand-edited),
// the two diverge and CI fails. Run `bun run tokens:generate` to fix.
if (process.argv.includes("--check")) {
  const committed = existsSync(OUT_PATH) ? readFileSync(OUT_PATH, "utf8") : "";
  if (committed !== tokensContent) {
    console.error(
      "[generate-css-tokens] shell/src/ui/styles/tokens.css is out of sync " +
        "with shell/src/ui/styles/theme.ts.\n" +
        "  Run `bun run tokens:generate` and commit the result.",
    );
    process.exit(1);
  }
  console.log("[generate-css-tokens] tokens.css is in sync with theme.ts.");
} else {
  writeFileSync(OUT_PATH, tokensContent, "utf8");
  console.log("Tokens synchronized strictly from typescript source.");
}
