#!/usr/bin/env bun
/**
 * WCAG contrast audit for the design tokens, in both themes.
 *
 *   bun scripts/contrast-audit.ts              # token role matrix
 *   bun scripts/contrast-audit.ts --rendered   # + axe color-contrast over every story
 *
 * The matrix checks each color token in the role it's used for, against
 * every surface it can sit on, in each theme:
 *   text      ≥ 4.5:1  (WCAG 1.4.3)
 *   non-text  ≥ 3:1    (WCAG 1.4.11 — icons, input borders, focus rings, bars)
 *   on-fill   ≥ 4.5:1  (label text on a filled button/badge)
 *
 * --rendered drives headless Edge/Chrome over the DevTools protocol against
 * a running Storybook (default http://127.0.0.1:6006, or STORYBOOK_URL),
 * once with the OS appearance emulated light and once dark, and runs axe's
 * color-contrast rule on every story — the pairings the CSS really produces.
 * Exits 1 if anything fails.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { themes } from "../../../shell/src/ui/styles/theme";
import { type Theme, matrix } from "../src/contrast";

// ---- rendered sweep ------------------------------------------------------------
async function rendered(): Promise<number> {
  const base = process.env.STORYBOOK_URL ?? "http://127.0.0.1:6006";
  const index = (await (await fetch(`${base}/index.json`)).json()) as {
    entries: Record<string, { id: string; type: string; title: string; name: string }>;
  };
  const stories = Object.values(index.entries).filter((e) => e.type === "story");
  const axeSource = readFileSync(
    resolve(import.meta.dir, "..", "node_modules/axe-core/axe.min.js"),
    "utf8",
  );

  const browser = [
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].find((p) => existsSync(p));
  if (!browser) throw new Error("No Edge/Chrome/Chromium found for --rendered");
  const port = 9300 + Math.floor(Math.random() * 500);
  const proc = Bun.spawn(
    [browser, "--headless=new", "--disable-gpu", `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "contrast-"))}`, "about:blank"],
    { stdout: "ignore", stderr: "ignore" },
  );

  try {
    let wsUrl = "";
    for (let i = 0; i < 50 && !wsUrl; i++) {
      await Bun.sleep(200);
      wsUrl = await fetch(`http://127.0.0.1:${port}/json/version`)
        .then((r) => r.json() as Promise<{ webSocketDebuggerUrl: string }>)
        .then((v) => v.webSocketDebuggerUrl)
        .catch(() => "");
    }
    const cdp = await connect(wsUrl);

    type Finding = { scheme: string; story: string; target: string; fg: string; bg: string; ratio: number; expected: string; text: string };
    const findings: Array<Finding> = [];
    const jobs = stories.flatMap((s) => (["light", "dark"] as const).map((scheme) => ({ s, scheme })));
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < jobs.length) {
        const { s, scheme } = jobs[next++];
        const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
        const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
        const send = (method: string, params: object = {}): Promise<any> => cdp.send(method, params, sessionId);
        await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
        await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        await send("Page.enable");
        await send("Page.navigate", { url: `${base}/iframe.html?id=${s.id}&viewMode=story&globals=theme:system` });
        await Bun.sleep(2500);
        const { result } = await send("Runtime.evaluate", {
          awaitPromise: true,
          returnByValue: true,
          expression: `(async () => {
            const src = ${JSON.stringify(axeSource)};
            eval(src);
            for (const f of document.querySelectorAll("iframe")) {
              try { f.contentWindow.eval(src); } catch {}
            }
            const r = await axe.run(document, { runOnly: ["color-contrast"], iframes: true, resultTypes: ["violations"] });
            return r.violations.flatMap((v) => v.nodes.map((n) => {
              const d = (n.any[0] || {}).data || {};
              return { target: n.target.join(" >>> "), fg: d.fgColor, bg: d.bgColor, ratio: d.contrastRatio, expected: d.expectedContrastRatio, text: (n.html || "").slice(0, 90) };
            }));
          })()`,
        });
        for (const f of (result.value ?? []) as Array<Omit<Finding, "scheme" | "story">>) {
          findings.push({ scheme, story: `${s.title} / ${s.name}`, ...f });
        }
        await cdp.send("Target.closeTarget", { targetId });
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));

    // Group identical color pairs so one bad token shows up once, with where.
    const groups = new Map<string, Array<Finding>>();
    for (const f of findings) {
      const key = `${f.scheme} ${f.fg} on ${f.bg} (${f.ratio}:1, needs ${f.expected})`;
      groups.set(key, [...(groups.get(key) ?? []), f]);
    }
    console.log(`\nRendered: ${stories.length} stories × light/dark, ${findings.length} failing elements, ${groups.size} distinct color pairs`);
    for (const [key, list] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
      const targets = [...new Set(list.map((f) => f.target))].slice(0, 4);
      console.log(`\n✗ ${key} — ${list.length}×`);
      for (const t of targets) console.log(`    ${t}`);
      console.log(`    e.g. ${list[0].story}: ${list[0].text}`);
    }
    return findings.length;
  } finally {
    proc.kill();
  }
}

async function connect(url: string): Promise<{ send: (method: string, params?: object, sessionId?: string) => Promise<any> }> {
  const ws = new WebSocket(url);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let id = 0;
  const pending = new Map<number, (v: any) => void>();
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data));
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)!(msg.error ? Promise.reject(new Error(msg.error.message)) : msg.result);
      pending.delete(msg.id);
    }
  };
  return {
    send: (method, params = {}, sessionId) =>
      new Promise((res) => {
        const msgId = ++id;
        pending.set(msgId, res);
        ws.send(JSON.stringify({ id: msgId, method, params, ...(sessionId ? { sessionId } : {}) }));
      }),
  };
}

// ---- report --------------------------------------------------------------------
if (import.meta.main) {
  const checks = matrix();
  const failing = checks.filter((c) => c.ratio < c.min);
  for (const theme of Object.keys(themes) as Array<Theme>) {
    console.log(`\n${theme.toUpperCase()}`);
    for (const c of checks.filter((x) => x.theme === theme)) {
      const mark = c.ratio >= c.min ? "  " : "✗ ";
      console.log(`${mark}${c.ratio.toFixed(2).padStart(5)}  --${c.fg} on --${c.bg}  [${c.role} ≥${c.min}] ${c.why}`);
    }
  }
  console.log(`\nMatrix: ${failing.length} of ${checks.length} pairings below their minimum.`);
  const renderedFailures = process.argv.includes("--rendered") ? await rendered() : 0;
  process.exit(failing.length + renderedFailures > 0 ? 1 : 0);
}
