import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { PluginsPanel } from "../features/plugins/PluginsPanel";

/**
 * Mounts the Plugins React island into #plugins-root.
 * Idempotent: no-op if the mount point is absent. Mirrors `mountApps`.
 */
export function mountPlugins(): void {
  const el = document.getElementById("plugins-root");
  if (!el) return;
  const root = createRoot(el);
  root.render(
    <StrictMode>
      <PluginsPanel />
    </StrictMode>,
  );
}
