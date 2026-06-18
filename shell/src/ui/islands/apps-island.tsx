import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { AppsPanel } from "../features/apps/AppsPanel";

/**
 * Mounts the Apps React island into #apps-root.
 * Idempotent: no-op if the mount point is absent. Mirrors
 * `mountApiClients` in api-clients-island.tsx.
 */
export function mountApps(): void {
  const el = document.getElementById("apps-root");
  if (!el) return;
  const root = createRoot(el);
  root.render(
    <StrictMode>
      <AppsPanel />
    </StrictMode>,
  );
}
