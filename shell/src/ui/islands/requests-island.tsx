import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { RequestsPanel } from "../features/requests/RequestsPanel";

/**
 * Mounts the Requests React island into #requests-root.
 * Idempotent: no-op if the mount point is absent. Mirrors `mountMcp`.
 */
export function mountRequests(): void {
  const el = document.getElementById("requests-root");
  if (!el) return;
  const root = createRoot(el);
  root.render(
    <StrictMode>
      <RequestsPanel />
    </StrictMode>,
  );
}
