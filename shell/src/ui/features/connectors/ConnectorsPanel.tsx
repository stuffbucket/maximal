import { useEffect, useRef, useState } from "react";

import { t } from "../../../i18n";
import { Button } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { ProblemCallout } from "../../components/ProblemCallout";
import { Stack } from "../../components/Stack";

import { ConnectorList } from "./ConnectorList";
import { connectorIdFromHash } from "./connector-state";
import { PluginDetailsDialog } from "./PluginDetailsDialog";
import { useConnectors } from "./useConnectors";

interface ConnectorsPanelProps {
  /** Open this plugin's detail dialog first (stories); else the hash decides. */
  initialConnectorId?: string;
}

function linkedConnector(): string | null {
  return connectorIdFromHash(window.location.hash);
}

/** Mirror the open plugin in the hash without adding history or firing
 *  `hashchange` (main.ts routes sections on it). */
function writeHash(id: string | null): void {
  const hash = id ? `#connectors/${encodeURIComponent(id)}` : "#connectors";
  if (window.location.hash !== hash) window.history.replaceState(null, "", hash);
}

/**
 * Settings → Integrations → Connectors. The list stays mounted while a Cordis
 * plugin opens in a large modal, mirrored in the hash as `#connectors/<id>` so
 * the detail can be linked to. Dismissal returns focus to the row that opened it.
 */
export function ConnectorsPanel({ initialConnectorId }: ConnectorsPanelProps): JSX.Element {
  const { connectors, isLoading, problem, version, refresh, replace } = useConnectors();
  const [openId, setOpenId] = useState<string | null>(() => initialConnectorId ?? linkedConnector());
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  const open = connectors.find((connector) => connector.id === openId);

  // A link to a plugin detail while Settings is already open.
  useEffect(() => {
    const onHashChange = (): void => setOpenId(linkedConnector());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const show = (id: string): void => {
    rowRefs.current.get(id)?.focus();
    writeHash(id);
    setOpenId(id);
  };

  // A successful inventory refresh can remove the plugin whose dialog is open.
  // Close the now-orphaned dialog and normalize its stale deep link.
  useEffect(() => {
    if (openId === null || isLoading || problem !== null) return;
    if (connectors.some((connector) => connector.id === openId)) return;
    writeHash(null);
    setOpenId(null);
  }, [connectors, isLoading, openId, problem]);

  const dismiss = (): void => {
    writeHash(null);
    setOpenId(null);
  };

  return (
    <Stack proximity="region" className="connectors-panel" aria-busy={isLoading}>
      {problem && (
        <ProblemCallout problem={problem} onRetry={() => void refresh()} onRestarted={() => void refresh()} />
      )}

      {isLoading && connectors.length === 0 ? (
        <p className="state__caption">{t("connectors-loading")}</p>
      ) : connectors.length === 0 ? (
        // The load error above wins over an empty state.
        !problem && (
          <EmptyState
            title={t("connectors-empty-title")}
            action={
              <Button size="sm" onClick={() => void refresh()}>
                {t("common-refresh")}
              </Button>
            }
          >
            <p>{t("connectors-empty-body")}</p>
          </EmptyState>
        )
      ) : (
        <ConnectorList connectors={connectors} onOpen={show} rowRefs={rowRefs} />
      )}

      <PluginDetailsDialog
        plugin={open ?? null}
        version={version}
        onFresh={replace}
        onDismiss={dismiss}
      />
    </Stack>
  );
}
