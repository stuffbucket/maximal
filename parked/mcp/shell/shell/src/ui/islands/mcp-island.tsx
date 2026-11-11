import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { McpPanel } from "../features/mcp/McpPanel";

/**
 * Mounts the MCP servers React island into #mcp-root.
 * Idempotent: no-op if the mount point is absent. Mirrors `mountApps`.
 */
export function mountMcp(): void {
  const el = document.getElementById("mcp-root");
  if (!el) return;
  const root = createRoot(el);
  root.render(
    <StrictMode>
      <McpPanel />
    </StrictMode>,
  );
}
