import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { Models } from "./features/models/Models";

/**
 * Mounts the Models React island into #models-root.
 * Idempotent: no-op if the mount point is absent. Mirrors
 * `mountApiClients` in api-clients-island.tsx.
 */
export function mountModels(): void {
  const el = document.getElementById("models-root");
  if (!el) return;
  const root = createRoot(el);
  root.render(
    <StrictMode>
      <Models />
    </StrictMode>,
  );
}
