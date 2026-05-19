import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { QuitConfirmDialog } from "./features/quit/QuitConfirmDialog";

/**
 * Mounts the quit-confirm React island into #quit-confirm-root.
 * Idempotent: safe to call once on DOMContentLoaded; no-op if the
 * mount point is missing (e.g. older index.html cache).
 */
export function mountQuitConfirm(): void {
  const el = document.getElementById("quit-confirm-root");
  if (!el) return;
  const root = createRoot(el);
  root.render(
    <StrictMode>
      <QuitConfirmDialog />
    </StrictMode>,
  );
}
