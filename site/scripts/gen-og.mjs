// Generate the social / link-unfurl card: a real screenshot of the hero card,
// written to public/og.png (referenced only by the OG/Twitter <meta> tags in
// src/pages/index.astro, so it never appears in the visible page).
//
// Needs a running site server. Easiest:
//   bun run dev      # in another terminal (serves http://localhost:4321/maximal)
//   bun run og       # this script
// Override the target with OG_URL=... if your dev server is elsewhere.
//
// Uses Playwright's bundled Chromium (installed at the repo root). Renders with
// reduced motion so the tagline is fully shown (no typing animation) and the
// WebGL paint is captured as a single static frame.
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";

const TARGET = process.env.OG_URL ?? "http://localhost:4321/maximal";
const OUT = fileURLToPath(new URL("../public/og.png", import.meta.url));
const W = 1200;
const H = 630; // 1.91:1 — the standard Open Graph / large-summary card ratio

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: W, height: 820 },
    deviceScaleFactor: 1, // output exactly 1200x630 to match the og:image meta
    colorScheme: "dark", // richer: the god-ray backdrop frames the hero card
    reducedMotion: "reduce",
  });
  await page.goto(TARGET, { waitUntil: "networkidle" });
  await page.waitForSelector(".hero");

  // Compose a clean card for the capture only (the live page is untouched):
  // hide the download buttons and the rest of the page, and pad the top so the
  // hero card sits centered in the frame, floating on the god-ray backdrop.
  //
  // NOTE: hide the buttons with visibility:hidden, NOT display:none — the card
  // must keep its full height so it covers the god-rays' central fade zone
  // (anchored to the hero's centre). display:none shrinks the card and exposes
  // that dark pocket below it as a "black box".
  await page.addStyleTag({
    content: `
      .hero-cta { visibility: hidden !important; }
      .hero-typed__caret { display: none !important; }
      main article section { display: none !important; }
      .dock { display: none !important; }
      main { padding-top: 200px !important; }
    `,
  });
  await page.waitForTimeout(900); // reflow + webfonts + the WebGL frame settle

  const box = await page.locator(".hero").boundingBox();
  if (!box) throw new Error("hero card not found on page");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const clip = {
    x: Math.max(0, Math.min(Math.round(cx - W / 2), W)),
    y: Math.max(0, Math.round(cy - H / 2)),
    width: W,
    height: H,
  };
  await page.screenshot({ path: OUT, clip });
  console.log(`wrote ${OUT} (${W}x${H})`);
} finally {
  await browser.close();
}
