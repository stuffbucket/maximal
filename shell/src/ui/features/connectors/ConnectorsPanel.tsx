import { useEffect, useRef, useState } from "react";

import { t } from "../../../i18n";
import { Button } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { ProblemCallout } from "../../components/ProblemCallout";
import { Stack } from "../../components/Stack";

import { ConnectorDetail } from "./ConnectorDetail";
import { ConnectorList } from "./ConnectorList";
import { useConnectors } from "./useConnectors";

interface ConnectorsPanelProps {
  /** Open this connector's page first (stories); else the hash decides. */
  initialConnectorId?: string;
}

const DEEP_LINK = /^#connectors\/([^/]+)$/;

/** `#connectors/workiq` → "workiq". */
function linkedConnector(): string | null {
  const match = DEEP_LINK.exec(window.location.hash);
  return match ? decodeURIComponent(match[1]) : null;
}

/** Mirror the open page in the hash without adding history or firing
 *  `hashchange` (main.ts routes sections on it). */
function writeHash(id: string | null): void {
  const hash = id ? `#connectors/${encodeURIComponent(id)}` : "#connectors";
  if (window.location.hash !== hash) window.history.replaceState(null, "", hash);
}

/**
 * Settings → Integrations → Connectors. The list of connectors, or one
 * connector's page in its place (in-section navigation, mirrored in the
 * hash as `#connectors/<id>` so it can be linked to; Back returns to the
 * list and puts focus back on the row that was opened).
 */
export function ConnectorsPanel({ initialConnectorId }: ConnectorsPanelProps): JSX.Element {
  const { connectors, isLoading, problem, version, refresh, replace } = useConnectors();
  const [openId, setOpenId] = useState<string | null>(() => initialConnectorId ?? linkedConnector());
  const [returnTo, setReturnTo] = useState<string | null>(null);
  // Focus moves to the page only when the user opened it here, not when a
  // link (or a story) opened it on load.
  const [focusPage, setFocusPage] = useState(false);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  const open = connectors.find((connector) => connector.id === openId);

  // A link to a connector's page while Settings is already open.
  useEffect(() => {
    const onHashChange = (): void => {
      const linked = linkedConnector();
      if (linked) setOpenId(linked);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const show = (id: string): void => {
    writeHash(id);
    setFocusPage(true);
    setOpenId(id);
  };

  useEffect(() => {
    if (openId !== null || returnTo === null) return;
    rowRefs.current.get(returnTo)?.focus();
    setReturnTo(null);
  }, [openId, returnTo]);

  const back = (): void => {
    writeHash(null);
    setReturnTo(openId);
    setOpenId(null);
  };

  return (
    <Stack proximity="region" className="connectors-panel" aria-busy={isLoading}>
      {problem && (
        <ProblemCallout problem={problem} onRetry={() => void refresh()} onRestarted={() => void refresh()} />
      )}

      {open ? (
        <ConnectorDetail
          key={open.id}
          summary={open}
          version={version}
          focusOnOpen={focusPage}
          onFresh={replace}
          onBack={back}
        />
      ) : isLoading && connectors.length === 0 ? (
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
    </Stack>
  );
}
