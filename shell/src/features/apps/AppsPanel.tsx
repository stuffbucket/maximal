import { AppCard } from "./AppCard";
import { useApps } from "./useApps";

export function AppsPanel(): JSX.Element {
  const {
    apps,
    isLoading,
    error,
    refresh,
    toggleClaudeCode,
    toggleClaudeDesktop,
  } = useApps();

  return (
    <div className="apps-panel" aria-busy={isLoading}>
      {error && (
        <p className="state__caption state__caption--error" role="alert">
          {error}
        </p>
      )}

      {isLoading && apps.length === 0 ? (
        <p className="state__caption">Looking for installed apps…</p>
      ) : (
        <div className="apps-list">
          {apps.map((app) => (
            <AppCard
              key={app.id}
              app={app}
              onRescan={refresh}
              onToggle={
                app.id === "claude-desktop"
                  ? (enabled) => toggleClaudeDesktop(enabled)
                  : (enabled) => toggleClaudeCode(enabled)
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
