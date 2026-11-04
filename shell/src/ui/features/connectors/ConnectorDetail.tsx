import { useEffect, useRef, useState } from "react";

import { t } from "../../../i18n";
import type { PluginClientId, PluginView } from "../../../proxy/client";
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import { LinkCheckbox } from "../../components/LinkCheckbox";
import { ProblemCallout } from "../../components/ProblemCallout";
import { Switch } from "../../components/Switch";
import type { Problem } from "../../problems";

import { ConfigForm } from "./ConfigForm";
import { connectorLine } from "./connector-state";
import { ConnectorStatusBlock } from "./ConnectorStatusBlock";
import { ConnectorText } from "./ConnectorText";
import { BackGlyph, ConnectorTile } from "./glyphs";
import { ToolPermissions } from "./ToolPermissions";
import { useConnectorDetail } from "./useConnectorDetail";

const COPIED_FLASH_MS = 1400;

/** Product names, not translated. */
const CLIENT_NAMES: Record<PluginClientId, string> = {
  "claude-code": "Claude Code",
};

interface Change {
  enabled: boolean;
  clients: Array<PluginClientId>;
}

interface ConnectorDetailProps {
  /** The list's copy, shown until the detail arrives. */
  summary: PluginView;
  /** Bumped by the list on every server nudge; the detail refetches. */
  version: number;
  /** Move focus to the page's heading on open (the user opened it here). */
  focusOnOpen: boolean;
  onFresh: (connector: PluginView) => void;
  onBack: () => void;
}

/**
 * One connector's page inside the Connectors section: back to the list, its
 * name and on/off switch, what it says about itself (state, detail, facts,
 * buttons), which apps get it and its endpoint, its tool permissions, its
 * configuration, and where it connects. Typographic sections divided by
 * hairlines, no cards: the page is the entity.
 */
export function ConnectorDetail({ summary, version, focusOnOpen, onFresh, onBack }: ConnectorDetailProps): JSX.Element {
  const { detail, problem, reload, update, setPermissions, runAction } = useConnectorDetail(
    summary.id,
    version,
    onFresh,
  );
  const connector: PluginView = detail ?? summary;
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  // Opening moves focus to the page's heading, so the next Tab continues
  // from the top of the page rather than from the row that disappeared.
  useEffect(() => {
    if (focusOnOpen) headingRef.current?.focus();
    // Once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The change in flight, shown in place of the server's state so the
  // controls don't snap back for the moment a save takes.
  const [pending, setPending] = useState<Change | null>(null);
  const [failed, setFailed] = useState<{ problem: Problem; change: Change } | null>(null);
  const [copied, setCopied] = useState(false);

  const busy = pending !== null;
  const enabled = pending?.enabled ?? connector.enabled;
  const chosen = new Set(pending?.clients ?? connector.clients.filter((c) => c.selected).map((c) => c.id));
  const line = connectorLine(connector);
  const failedToStart = connector.enabled && connector.lifecycle === "failed";

  const save = async (change: Change): Promise<void> => {
    setPending(change);
    setFailed(null);
    const result = await update(change);
    setPending(null);
    if (!result.ok && result.problem) setFailed({ problem: result.problem, change });
  };

  const setClient = (id: PluginClientId, checked: boolean): void => {
    const next = new Set(chosen);
    if (checked) next.add(id);
    else next.delete(id);
    void save({ enabled, clients: [...next] });
  };

  const copyEndpoint = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(connector.endpoint);
      setCopied(true);
      window.setTimeout(() => setCopied(false), COPIED_FLASH_MS);
    } catch {
      // Clipboard unavailable (plain browser, no permission). The address is
      // on screen for the user to select.
    }
  };

  const upstream = connector.manifest.connector;

  return (
    <article className="connector-detail" data-connector={connector.id} aria-busy={busy}>
      <div>
        <Button variant="ghost" size="sm" className="connector-detail__back" onClick={onBack}>
          <BackGlyph />
          {t("connectors-back")}
        </Button>
      </div>

      <header className="connector-detail__head">
        <ConnectorTile size="lg" />
        <h3 className="connector-detail__name" ref={headingRef} tabIndex={-1}>
          {connector.displayName}
        </h3>
        <div className="connector-detail__control">
          {busy && (
            <span className="connector-detail__saving" role="status">
              {t("connectors-saving")}
            </span>
          )}
          <Switch
            checked={enabled}
            disabled={busy}
            onCheckedChange={(next) => void save({ enabled: next, clients: [...chosen] })}
            label={enabled ? t("connectors-switch-on") : t("connectors-switch-off")}
          />
        </div>
      </header>

      <p className="connector-detail__desc">{connector.description}</p>

      {problem && (
        <ProblemCallout problem={problem} onRetry={() => void reload()} onRestarted={() => void reload()} />
      )}

      {failedToStart ? (
        <Callout tone="error" title={t("connectors-failed-title", { connector: connector.displayName })}>
          {connector.error && <p>{connector.error}</p>}
          <p>
            {/* The form can fix it only when the settings file was readable. */}
            {detail?.configSchema && detail.config
              ? t("connectors-failed-hint-config")
              : t("connectors-failed-hint")}
          </p>
        </Callout>
      ) : (
        // Off says itself through the switch; no second "Off" line under it.
        line && <ConnectorStatusBlock line={line} status={connector.status} onAction={runAction} />
      )}

      {failed && (
        <ProblemCallout
          problem={failed.problem}
          onRetry={() => void save(failed.change)}
          onRestarted={() => void reload()}
        />
      )}

      <section className="connector-section" aria-labelledby={`${connector.id}-connect-title`}>
        <div className="connector-section__head">
          <h4 className="connector-section__title" id={`${connector.id}-connect-title`}>
            {t("connectors-connect-title")}
          </h4>
        </div>
        {connector.clients.length > 0 && (
          <fieldset className="connector-clients" disabled={busy}>
            <legend className="sr-only">
              {t("connectors-client-legend", { connector: connector.displayName })}
            </legend>
            {connector.clients.map((client) => {
              const name = CLIENT_NAMES[client.id];
              const reason = client.available
                ? undefined
                : (client.reason ?? t("connectors-client-unavailable", { client: name }));
              return (
                <div className="connector-clients__row" key={client.id}>
                  <LinkCheckbox
                    label={name}
                    href="#apps"
                    checkboxLabel={t("connectors-client-aria", {
                      connector: connector.displayName,
                      client: name,
                    })}
                    checked={chosen.has(client.id)}
                    unavailable={reason}
                    onCheckedChange={(checked) => setClient(client.id, checked)}
                  />
                  {reason && <span className="connector-section__hint">{reason}</span>}
                </div>
              );
            })}
          </fieldset>
        )}
        <p className="connector-section__hint">{t("connectors-endpoint-hint")}</p>
        <div className="connector-endpoint">
          <code className="connector-endpoint__url mono">{connector.endpoint}</code>
          <Button
            size="sm"
            aria-label={t("connectors-endpoint-copy-aria", { connector: connector.displayName })}
            onClick={() => void copyEndpoint()}
          >
            {copied ? t("common-copied") : t("common-copy")}
          </Button>
        </div>
      </section>

      {detail && <ToolPermissions connector={detail} onChange={setPermissions} />}

      {/* An unreadable settings file has no config to edit, and Maximal
          won't write over it; the callout above says what to do instead. */}
      {detail?.configSchema && (detail.config || detail.lifecycle !== "failed") && (
        <ConfigForm connector={{ ...detail, configSchema: detail.configSchema }} onSave={update} />
      )}

      {(upstream || connector.homepage) && (
        <section className="connector-section" aria-labelledby={`${connector.id}-about-title`}>
          <div className="connector-section__head">
            <h4 className="connector-section__title" id={`${connector.id}-about-title`}>
              {t("connectors-about-title")}
            </h4>
          </div>
          <dl className="kv">
            {upstream && (
              <>
                <div className="kv__row">
                  <dt>{t("connectors-about-server")}</dt>
                  <dd className="mono connector-about__value">{upstream.endpoint}</dd>
                </div>
                <div className="kv__row">
                  <dt>{t("connectors-about-sign-in")}</dt>
                  <dd>{authLabel(upstream.auth.type)}</dd>
                </div>
                {upstream.terms && (
                  <div className="kv__row">
                    <dt>{t("connectors-about-terms")}</dt>
                    <dd className="connector-about__value">
                      <ConnectorText text={upstream.terms.url} />
                    </dd>
                  </div>
                )}
              </>
            )}
            {connector.homepage && (
              <div className="kv__row">
                <dt>{t("connectors-about-homepage")}</dt>
                <dd className="connector-about__value">
                  <ConnectorText text={connector.homepage} />
                </dd>
              </div>
            )}
          </dl>
        </section>
      )}
    </article>
  );
}

function authLabel(type: "entra" | "mcp-oauth" | "none"): string {
  switch (type) {
    case "entra":
      return t("connectors-auth-entra");
    case "mcp-oauth":
      return t("connectors-auth-mcp-oauth");
    case "none":
      return t("connectors-auth-none");
  }
}

