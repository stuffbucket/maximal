import { useEffect, useId, useState } from "react";

import { t } from "../../../i18n";
import type { PluginClientId, PluginView } from "../../../proxy/client";
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import { LinkCheckbox } from "../../components/LinkCheckbox";
import { ProblemCallout } from "../../components/ProblemCallout";
import { Switch } from "../../components/Switch";
import type { Problem } from "../../problems";

import { pluginLine } from "./plugin-state";
import { PluginStatusBlock } from "./PluginStatusBlock";
import { PluginTools } from "./PluginTools";
import type { PluginMutationResult } from "./usePlugins";

const COPIED_FLASH_MS = 1400;

/** Product names, not translated. */
const CLIENT_NAMES: Record<PluginClientId, string> = {
  "claude-code": "Claude Code",
};

interface Change {
  enabled: boolean;
  clients: Array<PluginClientId>;
}

interface PluginCardProps {
  plugin: PluginView;
  onUpdate: (change: Partial<Change>) => Promise<PluginMutationResult>;
  onAction: (actionId: string) => Promise<PluginMutationResult>;
  /** Re-read every plugin, e.g. after a failed save. */
  onRefresh: () => Promise<void>;
}

/**
 * One plugin as an accordion card, in the shape of the Apps and (formerly)
 * MCP cards. The head names it and carries the on/off switch; under it, the
 * plugin's description and what it says about itself (state, detail, facts,
 * buttons), which stay in view because "Sign in" must not hide behind a fold.
 * The twirldown folds away the rest: which apps get the plugin, its endpoint
 * address, and its tools. Everything is sections of one card, separated by
 * hairlines; nothing inside is a card.
 */
export function PluginCard({ plugin, onUpdate, onAction, onRefresh }: PluginCardProps): JSX.Element {
  // The change in flight, shown in place of the server's state so the
  // controls don't snap back for the moment a save takes.
  const [pending, setPending] = useState<Change | null>(null);
  const [failed, setFailed] = useState<{ problem: Problem; change: Change } | null>(null);
  const [copied, setCopied] = useState(false);

  const busy = pending !== null;
  const enabled = pending?.enabled ?? plugin.enabled;
  const chosen = new Set(
    pending?.clients ?? plugin.clients.filter((c) => c.selected).map((c) => c.id),
  );
  const line = pluginLine(plugin);
  const failedToStart = plugin.enabled && plugin.lifecycle === "failed";
  // Connections, endpoint and tools make sense once it is on and has started.
  const hasBody = enabled && !failedToStart;

  // Follows the switch: opens when it goes on, closes when it goes off. In
  // between, the twirldown lets the user fold the sections away.
  const [open, setOpen] = useState(hasBody);
  useEffect(() => setOpen(hasBody), [hasBody]);
  const bodyId = useId();

  const save = async (change: Change): Promise<void> => {
    setPending(change);
    setFailed(null);
    const result = await onUpdate(change);
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
      await navigator.clipboard.writeText(plugin.endpoint);
      setCopied(true);
      window.setTimeout(() => setCopied(false), COPIED_FLASH_MS);
    } catch {
      // Clipboard unavailable (plain browser, no permission). The address is
      // on screen for the user to select.
    }
  };

  return (
    <article className="app-card plugin-card" data-plugin={plugin.id} aria-busy={busy}>
      <header className="app-card__head">
        <div className="plugin-card__title">
          <h3 className="app-card__name">{plugin.displayName}</h3>
        </div>
        <div className="app-card__control">
          {busy && (
            <span className="plugin-card__saving" role="status">
              {t("plugins-saving")}
            </span>
          )}
          <Switch
            checked={enabled}
            disabled={busy}
            onCheckedChange={(next) =>
              void save({ enabled: next, clients: [...chosen] })
            }
            label={enabled ? t("plugins-switch-on") : t("plugins-switch-off")}
          />
          <Button
            variant="ghost"
            className="btn--icon plugin-card__twirl"
            aria-expanded={open}
            aria-controls={bodyId}
            aria-label={
              open
                ? t("plugins-twirl-hide", { plugin: plugin.displayName })
                : t("plugins-twirl-show", { plugin: plugin.displayName })
            }
            title={hasBody ? undefined : t("plugins-twirl-off", { plugin: plugin.displayName })}
            disabled={!hasBody}
            onClick={() => setOpen((prev) => !prev)}
          >
            <ChevronIcon />
          </Button>
        </div>
      </header>

      <p className="app-card__hint">{plugin.description}</p>

      {failedToStart ? (
        <Callout tone="error" title={t("plugins-failed-title", { plugin: plugin.displayName })}>
          {plugin.error && <p>{plugin.error}</p>}
          <p>{t("plugins-failed-hint")}</p>
        </Callout>
      ) : (
        // Off says itself through the switch; no second "Off" line under it.
        line && (
          <PluginStatusBlock line={line} status={plugin.status} onAction={onAction} />
        )
      )}

      <div className="plugin-card__body" id={bodyId} hidden={!open}>
        {plugin.clients.length > 0 && (
          <section className="plugin-card__section">
            <h4 className="plugin-card__heading">{t("plugins-connect-title")}</h4>
            <fieldset className="plugin-card__clients" disabled={busy}>
              <legend className="sr-only">
                {t("plugins-client-legend", { plugin: plugin.displayName })}
              </legend>
              {plugin.clients.map((client) => {
                const name = CLIENT_NAMES[client.id];
                const reason = client.available
                  ? undefined
                  : (client.reason ?? t("plugins-client-unavailable", { client: name }));
                return (
                  <div className="plugin-card__client" key={client.id}>
                    <LinkCheckbox
                      label={name}
                      href="#apps"
                      checkboxLabel={t("plugins-client-aria", {
                        plugin: plugin.displayName,
                        client: name,
                      })}
                      checked={chosen.has(client.id)}
                      unavailable={reason}
                      onCheckedChange={(checked) => setClient(client.id, checked)}
                    />
                    {reason && <span className="app-card__hint">{reason}</span>}
                  </div>
                );
              })}
            </fieldset>
          </section>
        )}

        <section className="plugin-card__section">
          <h4 className="plugin-card__heading">{t("plugins-endpoint-title")}</h4>
          <p className="app-card__hint">{t("plugins-endpoint-hint")}</p>
          <div className="plugin-card__endpoint">
            <code className="plugin-card__url mono">{plugin.endpoint}</code>
            <Button
              size="sm"
              aria-label={t("plugins-endpoint-copy-aria", { plugin: plugin.displayName })}
              onClick={() => void copyEndpoint()}
            >
              {copied ? t("common-copied") : t("common-copy")}
            </Button>
          </div>
        </section>

        {plugin.tools.length > 0 ? (
          <section className="plugin-card__section">
            <PluginTools tools={plugin.tools} />
          </section>
        ) : (
          plugin.lifecycle === "active" && (
            <section className="plugin-card__section">
              <p className="app-card__hint">{t("plugins-tools-none")}</p>
            </section>
          )
        )}
      </div>

      {failed && (
        <ProblemCallout
          problem={failed.problem}
          onRetry={() => void save(failed.change)}
          onRestarted={() => void onRefresh()}
        />
      )}
    </article>
  );
}

function ChevronIcon(): JSX.Element {
  // lucide: chevron-down; rotated 180° by CSS when open.
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
