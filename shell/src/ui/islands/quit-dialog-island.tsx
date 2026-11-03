import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { QuitConfirmDialog } from "../features/quit/QuitConfirmDialog";

export function mountQuitDialog(): void {
  const el = document.getElementById("quit-dialog-root");
  if (!el) return;

  createRoot(el).render(
    <StrictMode>
      <QuitConfirmDialog />
    </StrictMode>,
  );
}
