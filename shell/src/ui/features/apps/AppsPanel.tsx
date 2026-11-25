import { t } from "../../../i18n";

import { ProblemCallout } from "../../components/ProblemCallout";
import { Stack } from "../../components/Stack";
import { HarnessRow } from "./HarnessRow";
import { useApps } from "./useApps";

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

      <section className="subsection harnesses" aria-labelledby="harnesses-title">
        <header className="harnesses__header">
          <h3 id="harnesses-title" className="subsection__title">
            {t("apps-harnesses-title")}
          </h3>
          <p className="section__sub harnesses__description">
            {t("apps-harnesses-description")}
          </p>
        </header>

        {isLoading && apps.length === 0 ? (
          <p className="state__caption">{t("apps-loading")}</p>
        ) : (
          <div className="harnesses__table-wrap">
            <table className="table harnesses__table">
              <thead>
                <tr>
                  <th scope="col">{t("apps-col-harness")}</th>
                  <th scope="col">{t("apps-col-type")}</th>
                  <th scope="col" className="harnesses__status-heading">
                    {t("apps-col-status")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {apps.map((app) => (
                  <HarnessRow
                    key={app.id}
                    app={app}
                    onToggle={(enabled, options) =>
                      toggleApp(app.id, enabled, options)
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Stack>
  );
}
