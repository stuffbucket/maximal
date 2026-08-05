import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  fontStacks, text, weight, leading, tracking, spacing, radii, borderWidth, size,
  elevation, opacity, duration, easing, brand, accent, status, viz, link, focusRing, layout, themes
} from "../ui/theme";

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
    "/* AUTO-GENERATED FROM ui/theme.ts */",
    "/* Design tokens shared by Maximal desktop surfaces. */",
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

  rootLines.push("\n  /* ---- Opacity ---- */");
  Object.entries(opacity).forEach(([k, v]) => rootLines.push(`  --opacity-${k}: ${v};`));

  rootLines.push("\n  /* ---- Motion ---- */");
  Object.entries(duration).forEach(([k, v]) => rootLines.push(`  --duration-${k}: ${v};`));
  Object.entries(easing).forEach(([k, v]) => rootLines.push(`  --easing-${k}: ${v};`));

  rootLines.push("\n  /* ---- Colors ---- */");
  rootLines.push(...processGroup("brand", brand as any));
  const { hover, destructive, destructiveFg, ...accentBase } = accent;
  rootLines.push(...processGroup("accent", accentBase as any));
  rootLines.push(`  --accent-hover: ${hover};`);
  rootLines.push(`  --accent-destructive: ${destructive};`);
  rootLines.push(`  --accent-destructive-foreground: ${destructiveFg};`);
  
  rootLines.push("\n  /* ---- Semantic status ---- */");
  rootLines.push(...processGroup("status", status as any));

  rootLines.push("\n  /* ---- Data viz (Usage charts) ---- */");
  rootLines.push(...processGroup("viz", viz as any));

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


const OUT_PATHS = [
  "shell/src/ui/styles/tokens.css",
  "client/src/renderer/styles/tokens.css",
].map((path) => resolve(REPO, path));
const tokensContent = generateTokensCSS();

interface MirrorDeclaration {
  name: string;
  values: Array<string>;
}

interface MirrorSpec {
  path: string;
  declarations: Array<MirrorDeclaration>;
}

const MIRROR_SPECS: Array<MirrorSpec> = [
  {
    path: "shell/splash.html",
    declarations: [{ name: "--brand", values: [brand.color] }],
  },
  {
    path: "shell/update-confirm.html",
    declarations: [
      { name: "--brand", values: [brand.color] },
      { name: "--accent", values: [accent.color] },
      { name: "--accent-hover", values: [accent.hover] },
      { name: "--accent-fg", values: [accent.fg] },
      { name: "--surface", values: [themes.dark.surfaceBase] },
      { name: "--text-muted", values: [themes.dark.textMuted] },
      { name: "--border-subtle", values: [themes.dark.borderSubtle] },
    ],
  },
  {
    path: "site/src/styles/global.css",
    declarations: [
      { name: "--brand", values: [brand.color] },
      {
        name: "--bg",
        values: [themes.light.surfaceBase, themes.dark.surfaceBase],
      },
      {
        name: "--surface",
        values: [themes.light.surfaceCard, themes.dark.surfaceCard],
      },
      {
        name: "--surface-2",
        values: [themes.light.surfaceControl, themes.dark.surfaceControl],
      },
      {
        name: "--text",
        values: [themes.light.textStrong, themes.dark.textStrong],
      },
      {
        name: "--text-body",
        values: [themes.light.textBaseColor, themes.dark.textBaseColor],
      },
      {
        name: "--text-muted",
        values: [themes.light.textMuted, themes.dark.textMuted],
      },
      {
        name: "--border",
        values: [themes.light.borderSubtle, themes.dark.borderSubtle],
      },
      {
        name: "--border-strong",
        values: [themes.light.borderStrong, themes.dark.borderStrong],
      },
      { name: "--accent", values: [accent.color, accent.color] },
      { name: "--accent-hover", values: [accent.hover, accent.hover] },
      { name: "--accent-ink", values: [accent.fg, accent.fg] },
      { name: "--link", values: [link.light.color, link.dark.color] },
      { name: "--link-hover", values: [link.light.hover, link.dark.hover] },
    ],
  },
];

function synchronizeMirror(spec: MirrorSpec): {
  path: string;
  original: string;
  synchronized: string;
} {
  const path = resolve(REPO, spec.path);
  const original = readFileSync(path, "utf8");
  let synchronized = original;

  for (const declaration of spec.declarations) {
    const escapedName = declaration.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(${escapedName}:\\s*)#[0-9a-fA-F]{3,8}(\\s*;)`, "g");
    const matches = synchronized.match(pattern)?.length ?? 0;
    if (matches !== declaration.values.length) {
      throw new Error(
        `${spec.path}: expected ${declaration.values.length} ${declaration.name} mirror declaration(s), found ${matches}`,
      );
    }
    let occurrence = 0;
    synchronized = synchronized.replace(pattern, (_match, prefix, suffix) => {
      const value = declaration.values[occurrence];
      occurrence += 1;
      return `${prefix}${value}${suffix}`;
    });
  }

  return { path, original, synchronized };
}

const mirrors = MIRROR_SPECS.map(synchronizeMirror);

// `--check` verifies every generated stylesheet and explicit raw-value mirror
// against the neutral source without writing. Any stale or hand-edited target
// fails CI.
if (process.argv.includes("--check")) {
  const stale = OUT_PATHS.filter((path) => {
    const committed = existsSync(path) ? readFileSync(path, "utf8") : "";
    return committed !== tokensContent;
  });
  stale.push(
    ...mirrors
      .filter(({ original, synchronized }) => original !== synchronized)
      .map(({ path }) => path),
  );
  if (stale.length > 0) {
    console.error(
      "[generate-css-tokens] Generated token CSS or raw-value mirrors are out of sync with ui/theme.ts:\n" +
        stale.map((path) => `  - ${path.replace(`${REPO}/`, "")}`).join("\n") +
        "\n  Run `bun run tokens:generate` and commit every synchronized target.",
    );
    process.exit(1);
  }
  console.log(
    `[generate-css-tokens] ${OUT_PATHS.length} generated targets and ${mirrors.length} raw-value mirrors are in sync with ui/theme.ts.`,
  );
} else {
  for (const path of OUT_PATHS) writeFileSync(path, tokensContent, "utf8");
  for (const mirror of mirrors) {
    writeFileSync(mirror.path, mirror.synchronized, "utf8");
  }
  console.log(
    `Tokens synchronized to ${OUT_PATHS.length} generated targets and ${mirrors.length} raw-value mirrors.`,
  );
}
