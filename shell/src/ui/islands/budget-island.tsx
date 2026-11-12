import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { Budget } from "../features/budget/Budget";

/**
 * Mounts the Budget React island into #budget-root.
 * Idempotent: no-op if the mount point is absent. Mirrors `mountModels`.
 */
export function mountBudget(): void {
  const el = document.getElementById("budget-root");
  if (!el) return;
  const root = createRoot(el);
  root.render(
    <StrictMode>
      <Budget />
    </StrictMode>,
  );
}
