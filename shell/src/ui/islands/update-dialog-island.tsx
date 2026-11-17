import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { UpdateConfirmDialog } from "../features/update/UpdateConfirmDialog";

export function mountUpdateDialog(): void {
  const el = document.getElementById("update-dialog-root");
  if (!el) return;

  createRoot(el).render(
    <StrictMode>
      <UpdateConfirmDialog />
    </StrictMode>,
  );
}
