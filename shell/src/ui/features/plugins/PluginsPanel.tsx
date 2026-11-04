import { t } from "../../../i18n";

import { PluginCard } from "./PluginCard";
import { usePlugins } from "./usePlugins";
import { Button } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { ProblemCallout } from "../../components/ProblemCallout";
import { Stack } from "../../components/Stack";

export function PluginsPanel(): JSX.Element {
  const { plugins, isLoading, problem, refresh, update, runAction } = usePlugins();

  return (
    <Stack proximity="region" className="apps-panel" aria-busy={isLoading}>
      {problem && (
        <ProblemCallout
          problem={problem}
          onRetry={() => void refresh()}
          onRestarted={() => void refresh()}
        />
      )}

      {isLoading && plugins.length === 0 ? (
        <p className="state__caption">{t("plugins-loading")}</p>
      ) : plugins.length === 0 ? (
        // The load error above wins over an empty state.
        !problem && (
          <EmptyState
            title={t("plugins-empty-title")}
            action={
              <Button size="sm" onClick={() => void refresh()}>
                {t("common-refresh")}
              </Button>
            }
          >
            <p>{t("plugins-empty-body")}</p>
          </EmptyState>
        )
      ) : (
        <Stack proximity="section" className="apps-list">
          {plugins.map((plugin) => (
            <PluginCard
              key={plugin.id}
              plugin={plugin}
              onRefresh={refresh}
              onUpdate={(change) => update(plugin.id, change)}
              onAction={(actionId) => runAction(plugin.id, actionId)}
            />
          ))}
        </Stack>
      )}
    </Stack>
  );
}
