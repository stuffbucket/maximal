#!/usr/bin/env bun
/** Export Storybook stories as portable SVGs or tightly cropped raster assets. */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize, resolve } from "node:path";

import { chromium, type Page } from "@playwright/test";

import {
  assetFileStem,
  parseAssetArgs,
  selectStoryEntries,
  type AssetExportOptions,
  type AssetFormat,
  type AssetTheme,
  type StorybookEntry,
} from "./asset-policy";
import { cropBounds, type AssetBounds } from "./asset-crop";
import { REPO } from "./prepare-ui";

const PKG = resolve(import.meta.dir, "..");
const STATIC = join(PKG, "storybook-static");
const STORY_TIMEOUT_MS = 30_000;

const HELP = `Export Storybook stories as reusable assets.

Usage:
  bun run storybook:assets -- [story-id ...] [options]

Selection:
  --id <id>          export one story (repeatable; ids may also be positional)
  --match <glob>     export matching story ids, e.g. "assets-*"
  --tag <tag>        export stories carrying a tag (default: asset)
  --all              export every story
  --list             list story ids without exporting

Output:
  --format <format>  auto (SVG when portable, else WebP), svg, webp, or png
  --out <directory>  output directory (default: dist/storybook-assets)
  --selector <css>   crop or extract a specific element instead of the story root
  --theme <theme>    light or dark; repeatable (default: both)
  --locale <tag>     Storybook locale global (default: en)
  --viewport <WxH>   browser viewport (default: 1440x1200)
  --scale <1-4>      raster device scale (default: 2)
  --padding <0-128>  raster crop padding in CSS pixels (default: 8)
  --url <url>        use a running Storybook instead of building a static one
`;

interface StoryProbe {
  errors: Array<string>;
  finished: boolean;
  status: string | null;
}

interface ExportedAsset {
  file: string;
  format: Exclude<AssetFormat, "auto">;
  height: number;
  id: string;
  locale: string;
  name: string;
  pixelScale: number;
  scenario: string | null;
  tags: ReadonlyArray<string>;
  theme: string;
  title: string;
  width: number;
}

interface SvgAsset {
  height: number;
  source: string;
  width: number;
}

function storyEntry(value: unknown): StorybookEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.id !== "string" ||
    typeof entry.name !== "string" ||
    typeof entry.title !== "string" ||
    (entry.type !== "story" && entry.type !== "docs")
  ) {
    return null;
  }
  return {
    id: entry.id,
    name: entry.name,
    tags: Array.isArray(entry.tags) ? entry.tags.filter((tag): tag is string => typeof tag === "string") : [],
    title: entry.title,
    type: entry.type,
  };
}

async function storyIndex(baseUrl: string): Promise<Array<StorybookEntry>> {
  const response = await fetch(`${baseUrl}/index.json`);
  if (!response.ok) throw new Error(`Storybook index returned HTTP ${response.status}.`);
  const payload: unknown = await response.json();
  if (typeof payload !== "object" || payload === null || typeof (payload as { entries?: unknown }).entries !== "object") {
    throw new Error("Storybook index has no entries object.");
  }
  const raw = (payload as { entries: Record<string, unknown> }).entries;
  return Object.values(raw).map(storyEntry).filter((entry): entry is StorybookEntry => entry !== null);
}

async function buildStorybook(): Promise<void> {
  console.error("[storybook-assets] building static Storybook…");
  const build = Bun.spawn(["bun", "run", "build"], {
    cwd: PKG,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await build.exited) !== 0) throw new Error("Storybook build failed.");
}

async function staticServer(): Promise<{ close(): void; url: string }> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const pathname = decodeURIComponent(new URL(request.url).pathname);
      const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      const safe = normalize(relative);
      if (safe.startsWith("..") || isAbsolute(safe)) return new Response("Forbidden", { status: 403 });
      const file = Bun.file(join(STATIC, safe));
      if (!(await file.exists())) return new Response("Not found", { status: 404 });
      return new Response(file);
    },
  });
  return {
    close: () => server.stop(true),
    url: `http://${server.hostname}:${server.port}`,
  };
}

/**
 * Runs in the page before any Storybook code. Storybook 10 announces a story's
 * lifecycle on its preview channel: `storyFinished` fires after the render, the
 * play function and afterEach hooks, and the *Threw/Errored/Missing events carry
 * play and render failures. The channel is captured via a setter so no event
 * emitted during startup is missed.
 */
function installStoryProbe(): void {
  const probe: StoryProbe = { errors: [], finished: false, status: null };
  const scope = window as unknown as { __assetStory?: StoryProbe; __STORYBOOK_ADDONS_CHANNEL__?: unknown };
  scope.__assetStory = probe;
  const summarize = (payload: unknown): string => {
    if (typeof payload === "string") return payload;
    if (Array.isArray(payload)) return payload.map(summarize).join("; ");
    if (typeof payload === "object" && payload !== null) {
      const fields = payload as Record<string, unknown>;
      const text = [fields.name, fields.title, fields.message, fields.description].filter((part) => typeof part === "string");
      if (text.length > 0) return text.join(": ");
    }
    return JSON.stringify(payload) ?? "Unknown error";
  };
  interface Channel {
    on(event: string, listener: (payload: unknown) => void): void;
  }
  const attached = new WeakSet<object>();
  const attach = (value: unknown): void => {
    if (typeof value !== "object" || value === null || attached.has(value)) return;
    const channel = value as Channel;
    if (typeof channel.on !== "function") return;
    attached.add(value);
    channel.on("storyFinished", (payload) => {
      probe.finished = true;
      probe.status = (payload as { status?: string } | null)?.status ?? "success";
    });
    for (const event of [
      "playFunctionThrewException",
      "storyThrewException",
      "storyErrored",
      "storyMissing",
      "unhandledErrorsWhilePlaying",
    ]) {
      channel.on(event, (payload) => probe.errors.push(`${event}: ${summarize(payload)}`));
    }
  };
  let channel = scope.__STORYBOOK_ADDONS_CHANNEL__;
  attach(channel);
  Object.defineProperty(window, "__STORYBOOK_ADDONS_CHANNEL__", {
    configurable: true,
    get: () => channel,
    set: (value: unknown) => {
      channel = value;
      attach(value);
    },
  });
}

/** Wait for Storybook to finish the story (render + play) and fail on any play or render error. */
async function waitForStoryFinished(page: Page, id: string): Promise<void> {
  const handle = await page.waitForFunction(() => {
    const probe = (window as unknown as { __assetStory?: StoryProbe }).__assetStory;
    return probe !== undefined && (probe.finished || probe.errors.length > 0) ? JSON.stringify(probe) : "";
  });
  const probe = JSON.parse(await handle.jsonValue()) as StoryProbe;
  await handle.dispose();
  if (probe.errors.length > 0 || probe.status !== "success") {
    const detail = probe.errors.length > 0 ? probe.errors.join("\n") : `story finished with status ${probe.status}`;
    throw new Error(`${id} failed to render or play:\n${detail}`);
  }
}

async function readyStory(page: Page, id: string, selector: string | undefined): Promise<void> {
  await waitForStoryFinished(page, id);
  await page.waitForFunction(
    (target) => {
      const root = document.querySelector(target ?? "#storybook-root");
      return root !== null && (root.children.length > 0 || (root.textContent?.trim().length ?? 0) > 0);
    },
    selector,
  );
  await page.waitForFunction(
    (target) => {
      const root = document.querySelector(target ?? "#storybook-root");
      if (root === null) return false;
      return [...root.querySelectorAll("iframe")].every((frame) => {
        try {
          return frame.dataset.storybookReady !== "false" && frame.contentDocument?.readyState === "complete";
        } catch {
          return false;
        }
      });
    },
    selector,
  );
  await page.evaluate(async () => {
    const documents = [
      document,
      ...[...document.querySelectorAll("iframe")]
        .map((frame) => frame.contentDocument)
        .filter((nested): nested is Document => nested !== null),
    ];
    await Promise.all(documents.map(async (nested) => {
      await nested.fonts.ready;
      await Promise.all(
        [...nested.images]
          .filter((image) => !image.complete)
          .map(
            (image) =>
              new Promise<void>((resolveImage) => {
                image.addEventListener("load", () => resolveImage(), { once: true });
                image.addEventListener("error", () => resolveImage(), { once: true });
              }),
          ),
      );
    }));
  });
  await page.addStyleTag({
    content: "*,*::before,*::after{animation:none!important;caret-color:transparent!important;transition:none!important}",
  });
  // Modals, detail panes and other late-loading content: nothing may still
  // advertise itself as busy, and the layout (document extent plus every box
  // that can become the crop target) must hold still for several frames.
  await page.waitForFunction(() => document.querySelector('[aria-busy="true"]') === null);
  await page.evaluate(
    async (target) => {
      const signature = (): string => {
        const root = document.querySelector(target ?? "#storybook-root");
        const boxes = root === null ? [] : [root, ...root.children, ...root.querySelectorAll("dialog[open]")];
        return JSON.stringify([
          document.documentElement.scrollWidth,
          document.documentElement.scrollHeight,
          root?.textContent?.length ?? 0,
          boxes.map((element) => {
            const box = element.getBoundingClientRect();
            return [box.x, box.y, box.width, box.height];
          }),
        ]);
      };
      const frame = () => new Promise<void>((resolveFrame) => requestAnimationFrame(() => resolveFrame()));
      let previous = "";
      let steady = 0;
      for (let attempt = 0; attempt < 180 && steady < 3; attempt += 1) {
        await frame();
        const current = signature();
        steady = current === previous ? steady + 1 : 0;
        previous = current;
      }
      if (steady < 3) throw new Error("Story layout never settled.");
    },
    selector,
  );
  const errorDisplay = page.locator(".sb-errordisplay, #error-message").first();
  if (await errorDisplay.isVisible().catch(() => false)) {
    const error = await errorDisplay.textContent();
    throw new Error(`${id} rendered a Storybook error: ${error?.trim() || "Unknown render failure"}`);
  }
}

async function extractSvg(page: Page, selector: string | undefined): Promise<SvgAsset | null> {
  return await page.evaluate((target) => {
    const root = document.querySelector(target ?? "#storybook-root");
    if (!(root instanceof HTMLElement) && !(root instanceof SVGSVGElement)) return null;

    const visibleChildren = (element: Element): Array<Element> =>
      [...element.children].filter((child) => {
        if (child.tagName === "STYLE" || child.tagName === "SCRIPT") return false;
        const box = child.getBoundingClientRect();
        const style = getComputedStyle(child);
        return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
      });
    const directText = (element: Element): boolean =>
      [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent?.trim().length ?? 0) > 0);
    const neutralWrapper = (element: Element): boolean => {
      const style = getComputedStyle(element);
      const transparent = style.backgroundColor === "rgba(0, 0, 0, 0)" || style.backgroundColor === "transparent";
      return (
        transparent &&
        style.backgroundImage === "none" &&
        style.boxShadow === "none" &&
        style.borderTopWidth === "0px" &&
        style.borderRightWidth === "0px" &&
        style.borderBottomWidth === "0px" &&
        style.borderLeftWidth === "0px" &&
        style.paddingTop === "0px" &&
        style.paddingRight === "0px" &&
        style.paddingBottom === "0px" &&
        style.paddingLeft === "0px"
      );
    };

    let candidate: Element = root;
    while (!(candidate instanceof SVGSVGElement)) {
      const children = visibleChildren(candidate);
      if (children.length !== 1 || directText(candidate) || !neutralWrapper(candidate)) return null;
      candidate = children[0];
    }
    if (
      [...candidate.querySelectorAll("image")].some((image) => {
        const href = image.getAttribute("href") ?? image.getAttribute("xlink:href") ?? "";
        return href !== "" && !href.startsWith("data:");
      })
    ) {
      return null;
    }

    const box = candidate.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return null;
    const clone = candidate.cloneNode(true) as SVGSVGElement;
    const sourceElements = [candidate, ...candidate.querySelectorAll("*")];
    const clonedElements = [clone, ...clone.querySelectorAll("*")];
    const properties = [
      "color",
      "fill",
      "fill-opacity",
      "font-family",
      "font-size",
      "font-style",
      "font-weight",
      "letter-spacing",
      "opacity",
      "paint-order",
      "shape-rendering",
      "stroke",
      "stroke-dasharray",
      "stroke-dashoffset",
      "stroke-linecap",
      "stroke-linejoin",
      "stroke-miterlimit",
      "stroke-opacity",
      "stroke-width",
      "text-anchor",
      "vector-effect",
    ];
    for (let index = 0; index < sourceElements.length; index += 1) {
      const source = sourceElements[index];
      const computed = getComputedStyle(source);
      const parent = source.parentElement;
      const inherited = index === 0 || parent === null ? null : getComputedStyle(parent);
      const cloned = clonedElements[index] as HTMLElement | SVGElement;
      for (const property of properties) {
        const value = computed.getPropertyValue(property);
        if (value !== "" && (inherited === null || value !== inherited.getPropertyValue(property))) {
          cloned.style.setProperty(property, value);
        }
      }
    }
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", String(Math.round(box.width * 1000) / 1000));
    clone.setAttribute("height", String(Math.round(box.height * 1000) / 1000));
    return {
      width: box.width,
      height: box.height,
      source: `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}\n`,
    };
  }, selector);
}

/**
 * Crop target selection (deterministic):
 *  - `--selector`: exactly that element.
 *  - otherwise, if the story has open dialogs: the last open modal dialog in
 *    document order (a modal lives in the top layer, so the story root keeps
 *    the size of the page behind it and cropping the root would be wrong);
 *    with no modal, the last open non-modal dialog.
 *  - otherwise the union of the story root's visible children.
 * Padding and clamping are applied by `cropBounds`.
 */
async function assetBounds(page: Page, selector: string | undefined, padding: number): Promise<AssetBounds> {
  const target = await page.evaluate((target) => {
    const root = document.querySelector(target ?? "#storybook-root");
    if (root === null) return null;
    const dialogs = target === undefined ? [...root.querySelectorAll("dialog[open]")] : [];
    const modal = dialogs.filter((dialog) => dialog.matches(":modal"));
    const dialog = (modal.length > 0 ? modal : dialogs).at(-1);
    const candidates = dialog !== undefined ? [dialog] : target === undefined ? [...root.children] : [root];
    const boxes = candidates
      .filter((element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
      })
      .map((element) => element.getBoundingClientRect());
    const source = boxes.length > 0 ? boxes : [root.getBoundingClientRect()];
    const html = document.documentElement;
    return {
      left: Math.min(...source.map((box) => box.left)) + window.scrollX,
      top: Math.min(...source.map((box) => box.top)) + window.scrollY,
      right: Math.max(...source.map((box) => box.right)) + window.scrollX,
      bottom: Math.max(...source.map((box) => box.bottom)) + window.scrollY,
      pageWidth: Math.max(html.scrollWidth, window.innerWidth),
      pageHeight: Math.max(html.scrollHeight, window.innerHeight),
    };
  }, selector);
  if (target === null || target.right <= target.left || target.bottom <= target.top) {
    throw new Error(`The asset selector ${selector ?? "#storybook-root"} has no visible bounds.`);
  }
  return cropBounds(target, padding);
}

async function captureWebp(page: Page, bounds: AssetBounds, scale: number): Promise<Uint8Array> {
  const session = await page.context().newCDPSession(page);
  try {
    const result = await session.send("Page.captureScreenshot", {
      captureBeyondViewport: true,
      clip: { ...bounds, scale },
      format: "webp",
      fromSurface: true,
      quality: 100,
    });
    return Uint8Array.from(Buffer.from(result.data, "base64"));
  } finally {
    await session.detach();
  }
}

async function exportStory(
  page: Page,
  baseUrl: string,
  entry: StorybookEntry,
  options: AssetExportOptions,
  theme: AssetTheme,
  outDir: string,
): Promise<ExportedAsset> {
  const globals = `theme:${encodeURIComponent(theme)};locale:${encodeURIComponent(options.locale)}`;
  const url = `${baseUrl}/iframe.html?id=${encodeURIComponent(entry.id)}&viewMode=story&globals=${globals}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await readyStory(page, entry.id, options.selector);
  const scenario = await page.evaluate(
    () => document.documentElement.dataset.storybookScenario ?? null,
  );

  const stem = assetFileStem(entry, theme, options.locale);
  if (options.format === "auto" || options.format === "svg") {
    const svg = await extractSvg(page, options.selector);
    if (svg !== null) {
      const file = `${stem}.svg`;
      await writeFile(join(outDir, file), svg.source);
      return {
        file,
        format: "svg",
        height: svg.height,
        id: entry.id,
        locale: options.locale,
        name: entry.name,
        pixelScale: 1,
        scenario,
        tags: entry.tags,
        theme,
        title: entry.title,
        width: svg.width,
      };
    }
    if (options.format === "svg") {
      throw new Error(`${entry.id} is not a standalone portable SVG; use auto, webp, or png.`);
    }
  }

  const bounds = await assetBounds(page, options.selector, options.padding);
  const format = options.format === "png" ? "png" : "webp";
  const file = `${stem}.${format}`;
  if (format === "png") {
    await page.screenshot({ clip: bounds, path: join(outDir, file), type: "png" });
  } else {
    await writeFile(join(outDir, file), await captureWebp(page, bounds, options.scale));
  }
  return {
    file,
    format,
    height: bounds.height,
    id: entry.id,
    locale: options.locale,
    name: entry.name,
    pixelScale: options.scale,
    scenario,
    tags: entry.tags,
    theme,
    title: entry.title,
    width: bounds.width,
  };
}

async function main(): Promise<void> {
  const options = parseAssetArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }

  let local: Awaited<ReturnType<typeof staticServer>> | undefined;
  let baseUrl = options.url;
  if (baseUrl === undefined) {
    await buildStorybook();
    local = await staticServer();
    baseUrl = local.url;
  }

  try {
    const entries = await storyIndex(baseUrl);
    if (options.list) {
      for (const entry of entries.filter((item) => item.type === "story").sort((left, right) => left.id.localeCompare(right.id))) {
        console.log(`${entry.id}\t${entry.title} / ${entry.name}\t${entry.tags.join(",")}`);
      }
      return;
    }
    const selected = selectStoryEntries(entries, options);
    if (selected.length === 0) {
      throw new Error("No stories matched. Tag reusable stories with `asset`, or pass --id, --match, or --all.");
    }

    const outDir = resolve(REPO, options.outDir);
    if (options.outDir === "dist/storybook-assets") {
      await rm(outDir, { recursive: true, force: true });
    }
    await mkdir(outDir, { recursive: true });
    const browser = await chromium.launch({ headless: true });
    const exported: Array<ExportedAsset> = [];
    try {
      const context = await browser.newContext({
        deviceScaleFactor: options.scale,
        reducedMotion: "reduce",
        viewport: options.viewport,
      });
      const page = await context.newPage();
      page.setDefaultTimeout(STORY_TIMEOUT_MS);
      await page.addInitScript(installStoryProbe);
      for (const entry of selected) {
        for (const theme of options.themes) {
          const asset = await exportStory(page, baseUrl, entry, options, theme, outDir);
          exported.push(asset);
          console.error(`[storybook-assets] ${entry.id} (${theme}) → ${asset.file}`);
        }
      }
      await context.close();
    } finally {
      await browser.close();
    }
    await writeFile(
      join(outDir, "manifest.json"),
      `${JSON.stringify({ generatedFrom: baseUrl, assets: exported }, null, 2)}\n`,
    );
    console.log(`${exported.length} asset${exported.length === 1 ? "" : "s"} written to ${outDir}`);
  } finally {
    local?.close();
  }
}

if (import.meta.main) {
  await main();
}
