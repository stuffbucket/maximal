import { useCallback, useEffect, useState } from "react"

import type {
  DiagnosticsResponse,
  UpdateStatusResponse,
} from "@stuffbucket/maximal-core/settings-types"

import { apiCall } from "../../../proxy/client"

interface UseDiagnostics {
  data: DiagnosticsResponse | null
  updateStatus: UpdateStatusResponse | null
  isLoading: boolean
  /** Raw error string from the failed diagnostics fetch, or null. The component
   *  formats it via `t("diagnostics-err-load", { error })`. */
  error: string | null
  refresh: () => Promise<void>
}

/**
 * Data hook over `GET /control/diagnostics` (+ the best-effort
 * `/control/update-status`). Mirrors `useApps`: owns loading/error, fetches
 * on mount, and re-fetches on the `maximal:diagnostics-refresh` event main.ts
 * dispatches when the user navigates back to the section. `apiCall` returns a
 * Result and never throws.
 */
export function useDiagnostics(): UseDiagnostics {
  const [data, setData] = useState<DiagnosticsResponse | null>(null)
  const [updateStatus, setUpdateStatus] = useState<UpdateStatusResponse | null>(
    null,
  )
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const result = await apiCall({
      kind: "diagnostics",
      method: "GET",
      path: "/control/diagnostics",
    })
    if (result.ok) {
      setData(result.data)
      setError(null)
    } else {
      setError(result.error)
    }
    setIsLoading(false)

    // Best-effort, independent of the diagnostics fetch: the proxy caches the
    // GitHub ping for hours, so re-running on each section open is cheap. A
    // failure just leaves the update rows in their "unavailable" state.
    const upd = await apiCall({
      kind: "update-status",
      method: "GET",
      path: "/control/update-status",
    })
    setUpdateStatus(upd.ok ? upd.data : null)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const onRefresh = (): void => void refresh()
    globalThis.addEventListener("maximal:diagnostics-refresh", onRefresh)
    return () =>
      globalThis.removeEventListener("maximal:diagnostics-refresh", onRefresh)
  }, [refresh])

  return { data, updateStatus, isLoading, error, refresh }
}
