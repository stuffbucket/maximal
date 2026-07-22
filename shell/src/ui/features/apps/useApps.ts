import { useCallback, useEffect, useState } from "react"

import type { AppEntry } from "../../../proxy/client"

import { apiCall } from "../../../proxy/client"
import { humanize } from "../api-clients/humanize"

/**
 * Data hook over `/settings/api/apps`. Owns the list of integrations,
 * loading + error state, and the two mutation verbs the Apps screen needs.
 * Each mutation returns a single fresh `AppEntry` (the contract guarantees
 * this), which we splice back into the list in place — no full reload
 * needed, so the rest of the screen doesn't flicker.
 *
 * `refresh()` re-fetches the whole list and is exposed for the
 * "Re-scan" affordance (after the user installs Claude Code in their
 * terminal) and for the nav-driven refetch in main.ts.
 */
export interface MutationResult {
  ok: boolean
  error?: string
}

interface UseApps {
  apps: Array<AppEntry>
  isLoading: boolean
  error: string | null
  refresh: () => Promise<void>
  toggleClaudeCode: (enabled: boolean) => Promise<MutationResult>
  toggleClaudeDesktop: (enabled: boolean) => Promise<MutationResult>
}

function sortAlpha(apps: Array<AppEntry>): Array<AppEntry> {
  return [...apps].sort((a, b) => a.name.localeCompare(b.name))
}

export function useApps(): UseApps {
  const [apps, setApps] = useState<Array<AppEntry>>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const result = await apiCall({
      kind: "apps-list",
      method: "GET",
      path: "/settings/api/apps",
    })
    if (result.ok) {
      setApps(sortAlpha(result.data.apps))
      setError(null)
    } else {
      setError(humanize(result.error))
    }
    setIsLoading(false)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Re-scan when the user navigates back to the Apps section. main.ts
  // dispatches this on hashchange so detected installs stay fresh
  // (parallels the diagnostics/account refetch-on-nav behaviour).
  useEffect(() => {
    const onRefresh = (): void => void refresh()
    globalThis.addEventListener("maximal:apps-refresh", onRefresh)
    return () =>
      globalThis.removeEventListener("maximal:apps-refresh", onRefresh)
  }, [refresh])

  // Replace one app's state with the fresh object the mutation returned.
  const splice = useCallback((fresh: AppEntry) => {
    setApps((prev) =>
      sortAlpha(prev.map((app) => (app.id === fresh.id ? fresh : app))),
    )
  }, [])

  const toggleClaudeCode = useCallback<UseApps["toggleClaudeCode"]>(
    async (enabled) => {
      const result = await apiCall({
        kind: "claude-code-toggle",
        method: "POST",
        path: "/settings/api/apps/claude-code/toggle",
        body: { enabled },
      })
      if (!result.ok) {
        const message = humanize(result.error)
        setError(message)
        return { ok: false, error: message }
      }
      setError(null)
      splice(result.data)
      return { ok: true }
    },
    [splice],
  )

  const toggleClaudeDesktop = useCallback<UseApps["toggleClaudeDesktop"]>(
    async (enabled) => {
      const result = await apiCall({
        kind: "claude-desktop-toggle",
        method: "POST",
        path: "/settings/api/apps/claude-desktop/toggle",
        body: { enabled },
      })
      if (!result.ok) {
        const message = humanize(result.error)
        setError(message)
        return { ok: false, error: message }
      }
      setError(null)
      splice(result.data)
      return { ok: true }
    },
    [splice],
  )

  return {
    apps,
    isLoading,
    error,
    refresh,
    toggleClaudeCode,
    toggleClaudeDesktop,
  }
}
