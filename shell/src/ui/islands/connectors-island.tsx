import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ConnectorsPanel } from "../features/connectors/ConnectorsPanel";

/**
 * Mounts the Connectors React island into #connectors-root.
 * Idempotent: no-op if the mount point is absent. Mirrors `mountApps`.
 */
export function mountConnectors(): void {
  const el = document.getElementById("connectors-root");
  if (!el) return;
  const root = createRoot(el);
  root.render(
    <StrictMode>
      <ConnectorsPanel />
    </StrictMode>,
  );
}
