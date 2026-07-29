import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { ErrorBoundary } from "../components/ErrorBoundary"
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
      <ErrorBoundary
        fallback={
          <p className="card__hint" role="alert">
            Diagnostics couldn’t be displayed. Reopen the section, and if it
            persists, restart Maximal.
          </p>
        }
      >
        <Diagnostics />
      </ErrorBoundary>
    </StrictMode>,
  )
}
