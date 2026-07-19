import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { ApiClients } from "../features/api-clients/ApiClients"

/**
 * Mounts the API-clients React island into #api-clients-root.
 * Idempotent: no-op if the mount point is absent.
 */
export function mountApiClients(): void {
  const el = document.querySelector("#api-clients-root")
  if (!el) return
  const root = createRoot(el)
  root.render(
    <StrictMode>
      <ApiClients />
    </StrictMode>,
  )
}
