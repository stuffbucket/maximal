import { AppCard } from "./AppCard";
import { useApps } from "./useApps";
import { ProblemCallout } from "../../components/ProblemCallout";
import { Stack } from "../../components/Stack";

export function AppsPanel(): JSX.Element {
  const {
    apps,
    isLoading,
    problem,
    refresh,
    toggleClaudeCode,
    toggleClaudeDesktop,
  } = useApps();

  return (
    <Stack proximity="region" className="apps-panel" aria-busy={isLoading}>
      {problem && (
        <ProblemCallout
          problem={problem}
          onRetry={() => void refresh()}
          onRestarted={() => void refresh()}
        />
      )}

      {isLoading && apps.length === 0 ? (
        <p className="state__caption">Looking for installed apps…</p>
      ) : (
        <Stack proximity="section" className="apps-list">
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
        </Stack>
      )}
    </Stack>
  );
}