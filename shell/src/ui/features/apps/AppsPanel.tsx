import { t } from "../../../i18n";

import { AppCard } from "./AppCard";
import { useApps } from "./useApps";
import { ProblemCallout } from "../../components/ProblemCallout";
import { Stack } from "../../components/Stack";

export function AppsPanel(): JSX.Element {
  const { apps, isLoading, problem, refresh, toggleApp } = useApps();

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
        <p className="state__caption">{t("apps-loading")}</p>
      ) : (
        <Stack proximity="section" className="apps-list">
          {apps.map((app) => (
            <AppCard
              key={app.id}
              app={app}
              onRescan={refresh}
              onToggle={(enabled) => toggleApp(app.id, enabled)}
            />
          ))}
        </Stack>
      )}
    </Stack>
  );
}