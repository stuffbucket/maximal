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
    viewport: { width: W, height: H },
    deviceScaleFactor: 1, // output exactly 1200x630 to match the og:image meta
    colorScheme: "dark", // richer: the god-ray backdrop frames the hero card
    reducedMotion: "reduce",
  });
  await page.goto(TARGET, { waitUntil: "networkidle" });
  await page.waitForSelector(".hero");

  // Compose a clean card for the capture only (the live page is untouched):
  //  - hide the download buttons (visibility:hidden keeps the card's height),
  //    the typing caret, the other sections, and the dock;
  //  - pin the hero dead-centre at a generous size.
  // Centering is load-bearing: the god-rays light source is anchored to the
  // hero's centre, so a large card centred on that point fully covers the
  // shader's central fade zone — otherwise it peeks out below the card as a
  // dark box. The card half-height must exceed the fade radius (~0.26 * H).
  await page.addStyleTag({
    content: `
      .hero-cta { visibility: hidden !important; }
      .hero-typed__caret { display: none !important; }
      main article section, .dock { display: none !important; }
      .hero {
        position: fixed !important;
        top: 50% !important;
        left: 50% !important;
        transform: translate(-50%, -50%) !important;
        width: 880px !important;
        min-height: 392px !important;
        margin: 0 !important;
        display: flex !important;
        flex-direction: column !important;
        justify-content: center !important;
        z-index: 5 !important;
      }
    `,
  });

  // The hero just moved + resized. Force the god-rays backdrop to re-anchor its
  // light to the new (centred) hero — under reduced motion it only redraws on a
  // resize/scroll, not a rAF loop — so its fade zone re-centres on the card.
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  await page.waitForTimeout(1000); // reflow + webfonts + the WebGL frame settle

  await page.screenshot({ path: OUT });
  console.log(`wrote ${OUT} (${W}x${H})`);
} finally {
  await browser.close();
}
