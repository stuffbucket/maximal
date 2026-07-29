// Generate the social / link-unfurl card: a screenshot of the hero, written to
// public/og.png (referenced only by the OG/Twitter <meta> tags in
// src/pages/index.astro, so it never appears in the visible page).
//
// Needs a running site server. Easiest:
//   bun run dev      # in another terminal (serves http://localhost:4321/)
//   bun run og       # this script
// Override the target with OG_URL=... if your dev server is elsewhere.
//
// Uses Playwright's bundled Chromium (installed at the repo root). Renders dark
// (the hero's intended canvas) with reduced motion.
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";

const TARGET = process.env.OG_URL ?? "http://localhost:4321/";
const OUT = fileURLToPath(new URL("../public/og.png", import.meta.url));
const W = 1200;
const H = 630; // 1.91:1 — the standard Open Graph / large-summary card ratio

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1, // output exactly 1200x630 to match the og:image meta
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  await page.goto(TARGET, { waitUntil: "networkidle" });
  await page.waitForSelector(".hero");

  // Compose a clean card for the capture only (the live page is untouched):
  // hide the download buttons and everything below the hero, then pin the
  // kicker + wordmark + tagline centred on the dark canvas.
  await page.addStyleTag({
    content: `
      .hero-cta { visibility: hidden !important; }
      main article section, .dock { display: none !important; }
      .hero {
        position: fixed !important;
        top: 50% !important;
        left: 50% !important;
        transform: translate(-50%, -50%) !important;
        width: 900px !important;
        margin: 0 !important;
        z-index: 5 !important;
      }
    `,
  });

  await page.waitForTimeout(600); // reflow + self-hosted webfonts settle

  await page.screenshot({ path: OUT });
  console.log(`wrote ${OUT} (${W}x${H})`);
} finally {
  await browser.close();
}
