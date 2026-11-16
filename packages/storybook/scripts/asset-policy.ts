export type AssetFormat = "auto" | "png" | "svg" | "webp";
export type AssetTheme = "dark" | "light";

export interface StorybookEntry {
  id: string;
  name: string;
  tags: ReadonlyArray<string>;
  title: string;
  type: "docs" | "story";
}

export interface AssetExportOptions {
  all: boolean;
  format: AssetFormat;
  help: boolean;
  ids: ReadonlyArray<string>;
  list: boolean;
  locale: string;
  matches: ReadonlyArray<string>;
  outDir: string;
  padding: number;
  scale: number;
  selector?: string;
  tags: ReadonlyArray<string>;
  themes: ReadonlyArray<AssetTheme>;
  url?: string;
  viewport: { height: number; width: number };
}

function nextValue(args: ReadonlyArray<string>, index: number, option: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} needs a value.`);
  }
  return value;
}

function integer(raw: string, option: string, minimum: number, maximum: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${option} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function viewport(raw: string): { height: number; width: number } {
  const match = /^(\d+)x(\d+)$/u.exec(raw);
  if (match === null) throw new Error("--viewport must look like 1440x1200.");
  return {
    width: integer(match[1], "--viewport width", 320, 7680),
    height: integer(match[2], "--viewport height", 240, 4320),
  };
}

function localeValue(raw: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/iu.test(raw)) {
    throw new Error("--locale must contain only letters, numbers, and hyphens.");
  }
  return raw;
}

export function parseAssetArgs(args: ReadonlyArray<string>): AssetExportOptions {
  const ids: Array<string> = [];
  const matches: Array<string> = [];
  const tags: Array<string> = [];
  let all = false;
  let format: AssetFormat = "auto";
  let help = false;
  let list = false;
  let locale = "en";
  let outDir = "dist/storybook-assets";
  let padding = 8;
  let scale = 2;
  let selector: string | undefined;
  const themes: Array<AssetTheme> = [];
  let url: string | undefined;
  let size = { width: 1440, height: 1200 };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (!arg.startsWith("--")) {
      ids.push(arg);
      continue;
    }
    if (arg === "--all") all = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--list") list = true;
    else if (arg === "--id") ids.push(nextValue(args, index++, arg));
    else if (arg === "--match") matches.push(nextValue(args, index++, arg));
    else if (arg === "--tag") tags.push(nextValue(args, index++, arg));
    else if (arg === "--out") outDir = nextValue(args, index++, arg);
    else if (arg === "--selector") selector = nextValue(args, index++, arg);
    else if (arg === "--url") url = nextValue(args, index++, arg).replace(/\/+$/u, "");
    else if (arg === "--locale") locale = localeValue(nextValue(args, index++, arg));
    else if (arg === "--padding") padding = integer(nextValue(args, index++, arg), arg, 0, 128);
    else if (arg === "--scale") scale = integer(nextValue(args, index++, arg), arg, 1, 4);
    else if (arg === "--viewport") size = viewport(nextValue(args, index++, arg));
    else if (arg === "--format") {
      const value = nextValue(args, index++, arg);
      if (value !== "auto" && value !== "png" && value !== "svg" && value !== "webp") {
        throw new Error("--format must be auto, svg, webp, or png.");
      }
      format = value;
    } else if (arg === "--theme") {
      const value = nextValue(args, index++, arg);
      if (value !== "dark" && value !== "light") {
        throw new Error("--theme must be dark or light.");
      }
      if (!themes.includes(value)) themes.push(value);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  const selectedTags = all || ids.length > 0 || matches.length > 0 || tags.length > 0 || list ? tags : ["asset"];
  return {
    all,
    format,
    help,
    ids,
    list,
    locale,
    matches,
    outDir,
    padding,
    scale,
    ...(selector === undefined ? {} : { selector }),
    tags: selectedTags,
    themes: themes.length === 0 ? ["light", "dark"] : themes,
    ...(url === undefined ? {} : { url }),
    viewport: size,
  };
}

function wildcard(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^${escaped.replaceAll("*", ".*").replaceAll("?", ".")}$`, "u");
}

export function selectStoryEntries(
  entries: ReadonlyArray<StorybookEntry>,
  options: Pick<AssetExportOptions, "all" | "ids" | "matches" | "tags">,
): Array<StorybookEntry> {
  const stories = entries.filter((entry) => entry.type === "story");
  const byId = new Map(stories.map((entry) => [entry.id, entry]));
  const missing = options.ids.filter((id) => !byId.has(id));
  if (missing.length > 0) throw new Error(`Unknown story ${missing.join(", ")}. Use --list to see story ids.`);

  if (options.all) return [...stories].sort((left, right) => left.id.localeCompare(right.id));
  const patterns = options.matches.map(wildcard);
  const selected = stories.filter(
    (entry) =>
      options.ids.includes(entry.id) ||
      patterns.some((pattern) => pattern.test(entry.id)) ||
      options.tags.some((tag) => entry.tags.includes(tag)),
  );
  return selected.sort((left, right) => left.id.localeCompare(right.id));
}

export function assetFileStem(entry: Pick<StorybookEntry, "id">, theme: AssetTheme, localeName: string): string {
  const safeLocale = localeValue(localeName);
  const suffix = safeLocale === "en" ? theme : `${theme}--${safeLocale}`;
  return `${entry.id.replaceAll(/[^a-z0-9-]+/giu, "-")}--${suffix}`;
}
