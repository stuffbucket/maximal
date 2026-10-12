import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { AppEntry } from "../../../proxy/client";
import { AppCard } from "./AppCard";

const base: AppEntry = {
  id: "codex", name: "Codex CLI and Desktop", kind: "config", enabled: false,
  status: "ready", installs: [], install: null, conflict: null,
  routing: { model: "gpt-6-luna", available_models: [], managed: false },
};
function render(app: AppEntry): string {
  return renderToStaticMarkup(<AppCard app={app} onToggle={() => Promise.resolve({ ok: true })} onRescan={() => Promise.resolve()} />);
}

describe("Codex connection card", () => {
  test("offers an off toggle and explains the existing approval preference", () => {
    const html = render(base);
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("Off");
    expect(html).not.toContain('checked=""');
    expect(html).not.toContain("<button ");
    expect(html).toContain("GitHub Copilot");
    expect(html).toContain("approval settings");
    expect(html).not.toContain("ChatGPT");
    expect(html).not.toContain("Set up automatic reviews");
  });
  test("configured connections show an on toggle and restart guidance", () => {
    const html = render({ ...base, enabled: true, routing: { ...base.routing!, managed: true, automatic_review: true, review_update_required: false } });
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked=""');
    expect(html).not.toContain("Disconnect");
    expect(html).toContain("Restart Codex");
    expect(html).toContain("new local chat");
    expect(html).not.toContain("<button ");
    expect(html).not.toContain("Update connection");
  });
  test("existing and outdated installations update through the connection action", () => {
    const html = render({ ...base, enabled: true, routing: { ...base.routing!, managed: true, automatic_review: false, review_update_required: true } });
    expect(html).toContain("Update connection");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked=""');
    expect(html).not.toContain("Disconnect");
    expect(html).toContain("supported task models");
    expect(html).not.toContain("ChatGPT");
  });
  test("the on toggle remains available if Codex has been uninstalled", () => {
    const html = render({ ...base, enabled: true, status: "not-installed" });
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked=""');
    expect(html).not.toContain("Disconnect");
    expect(html).not.toContain("Update connection");
    expect(html).not.toContain('disabled=""');
  });
});
