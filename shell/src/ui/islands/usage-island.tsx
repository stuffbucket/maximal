import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { Usage } from "../features/usage/Usage";

/**
 * Mounts the Usage React island into #usage-root (spec §4). Idempotent: no-op if
 * the mount point is absent. Mirrors `mountModels` in models-island.tsx.
 */
export function mountUsage(): void {
  const el = document.getElementById("usage-root");
  if (!el) return;
  const root = createRoot(el);
  root.render(
    <StrictMode>
      <Usage />
    </StrictMode>,
  );
}
