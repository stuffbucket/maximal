// Browser entry (issue #221): upgrade the server-rendered download controls from
// the runtime manifest so a new release advertises itself with no site rebuild.
//
// This is a BUNDLED Astro <script> (not is:inline) so it can import the pure,
// type-checked parser (hydrate-manifest.ts) that consumes the shared schema-2
// types. It runs after the fallback HTML is already painted; a failed or
// malformed fetch is swallowed and the baked /releases-or-last-known fallback
// stays in place (fail-closed — see docs/decisions/site-runtime-version-manifest.md).
//
// SECURITY: the site is browser-only; reading downloads.<slot>.url here is the
// intended consumer of that field (a user-visible, clickable link). The desktop
// client must never do this — it reads only `version`.

import { readStableDownloads, type HydratedDownloads } from "./hydrate-manifest";

/** Point an anchor at a fresh URL. No-op for a blank/undefined URL so a missing
 *  slot never clobbers a good baked href. */
function setAnchorHref(el: HTMLAnchorElement, url: string | null): void {
  if (url) el.setAttribute("href", url);
}

/** Turn a disabled "coming soon" placeholder <div data-os="windows"> into a
 *  real download anchor when the manifest starts advertising Windows. Rewrites
 *  the meta pill from "coming soon" to the version. Idempotent for an element
 *  that is already an anchor. */
function upgradeWindowsControl(url: string, versionLabel: string): void {
  const el = document.querySelector<HTMLElement>('[data-os="windows"]');
  if (!el) return;

  if (el instanceof HTMLAnchorElement) {
    setAnchorHref(el, url);
    return;
  }

  // Rebuild the placeholder div as an anchor, preserving the label/spark markup
  // but dropping the "coming soon" state.
  const anchor = document.createElement("a");
  anchor.className = el.className.replace(/\bbtn--soon\b/, "btn--primary").trim();
  anchor.setAttribute("data-os", "windows");
  anchor.setAttribute("href", url);
  anchor.setAttribute("rel", "noopener");

  const label = el.querySelector(".btn-label");
  if (label) anchor.appendChild(label.cloneNode(true));

  const meta = document.createElement("span");
  meta.className = "btn-meta";
  meta.setAttribute("data-version-pill", "");
  meta.textContent = versionLabel;
  anchor.appendChild(meta);

  el.replaceWith(anchor);
}

/** Apply parsed manifest data to the DOM. Each field is optional: an absent
 *  macOS/Windows URL leaves that control's baked fallback untouched. */
function apply(data: HydratedDownloads): void {
  document
    .querySelectorAll<HTMLAnchorElement>('a[data-os="mac"]')
    .forEach((a) => setAnchorHref(a, data.macDmg));

  document.querySelectorAll<HTMLAnchorElement>('a[data-os="windows"]').forEach((a) => {
    setAnchorHref(a, data.winSetup);
  });

  if (data.hasWindows && data.winSetup) {
    upgradeWindowsControl(data.winSetup, data.versionLabel);
  }

  // Refresh every version pill (both Hero + GetStarted) to the manifest's tag.
  document
    .querySelectorAll<HTMLElement>("[data-version-pill]")
    .forEach((el) => {
      el.textContent = data.versionLabel;
    });
}

async function hydrate(): Promise<void> {
  // Same-origin (Pages serves both the page and the manifest) ⇒ no CORS. The
  // manifest is CDN-cached with a short TTL, so a plain fetch is enough.
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/updates/manifest.json`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return; // keep the baked fallback
    const data = readStableDownloads(await res.json());
    if (data) apply(data);
  } catch {
    // Network error / malformed JSON ⇒ do nothing (fail-closed).
  }
}

void hydrate();
