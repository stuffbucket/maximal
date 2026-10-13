import { t } from "../../../i18n";

import { AppCard } from "./AppCard";
import { useApps } from "./useApps";
import { Stack } from "../../components/Stack";

export function AppsPanel(): JSX.Element {
  const { apps, isLoading, error, refresh, toggleApp } = useApps();

  return (
    <Stack proximity="region" className="apps-panel" aria-busy={isLoading}>
      {error && (
        <p className="state__caption state__caption--error" role="alert">
          {error}
        </p>
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