import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { isNativeShell } from "../../proxy/browser-auth";
import { BrowserAuth } from "../features/browser-auth/BrowserAuth";

/** Browser access to a headless Maximal. The app's shell supplies its own
 *  key, so the native window never mounts it. */
export function mountBrowserAuth(): void {
  const root = document.getElementById("browser-auth-root");
  if (!root) return;
  if (isNativeShell()) {
    root.hidden = true;
    return;
  }
  createRoot(root).render(
    <StrictMode>
      <BrowserAuth />
    </StrictMode>,
  );
}
