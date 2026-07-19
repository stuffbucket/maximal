import type { ReactElement } from "react"

import { Stack } from "../../components/Stack"
import { AppCard } from "./AppCard"
import { useApps } from "./useApps"

export function AppsPanel(): ReactElement {
  const {
    apps,
    isLoading,
    error,
    refresh,
    toggleClaudeCode,
    toggleClaudeDesktop,
  } = useApps()

  return (
    <Stack proximity="region" className="apps-panel" aria-busy={isLoading}>
      {error && (
        <p className="state__caption state__caption--error" role="alert">
          {error}
        </p>
      )}

      {isLoading && apps.length === 0 ?
        <p className="state__caption">Looking for installed apps…</p>
      : <Stack proximity="section" className="apps-list">
          {apps.map((app) => (
            <AppCard
              key={app.id}
              app={app}
              onRescan={refresh}
              onToggle={
                app.id === "claude-desktop" ?
                  (enabled) => toggleClaudeDesktop(enabled)
                : (enabled) => toggleClaudeCode(enabled)
              }
            />
          ))}
        </Stack>
      }
    </Stack>
  )
}
