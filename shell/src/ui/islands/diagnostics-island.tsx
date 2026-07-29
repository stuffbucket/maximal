import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { Diagnostics } from "../features/diagnostics/Diagnostics"

/**
 * Mounts the Diagnostics React island into #diagnostics-root.
 * Idempotent: no-op if the mount point is absent. Mirrors `mountApps` in
 * apps-island.tsx.
 */
export function mountDiagnostics(): void {
  const el = document.querySelector("#diagnostics-root")
  if (!el) return
  const root = createRoot(el)
  root.render(
    <StrictMode>
      <Diagnostics />
    </StrictMode>,
  )
}
