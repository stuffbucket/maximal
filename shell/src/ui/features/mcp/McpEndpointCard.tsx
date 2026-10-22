import { useEffect, useId, useState } from "react";

import type {
  McpClientId,
  McpClientOffer,
  McpEndpointEntry,
  McpEndpointToggleResponse,
} from "../../../proxy/client";
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ProblemCallout } from "../../components/ProblemCallout";
import type { Problem } from "../../problems";
import { Checkbox } from "../../components/Checkbox";
import { LinkCheckbox } from "../../components/LinkCheckbox";
import { Switch } from "../../components/Switch";

import type { McpMutationResult, McpToggleResult } from "./useMcp";

interface McpEndpointCardProps {
  endpoint: McpEndpointEntry;
  onToggle: (
    enabled: boolean,
    clients?: Array<McpClientId>,
  ) => Promise<McpToggleResult>;
  /** Re-read every endpoint, e.g. after changing an app's config by hand. */
  onRefresh: () => Promise<void>;
  /** Remove it from Maximal and from every app Maximal added it to. */
  onRemove: () => Promise<McpMutationResult>;
}

interface Change {
  enabled: boolean;
  clients: Array<McpClientId>;
}

/**
 * One brokered MCP endpoint as an accordion card. The switch turns it on
 * or off; the twirldown at the right reveals one checkbox per app saying
 * which apps get it. Turning it on opens the card, turning it off closes
 * it and disables the twirldown — the apps don't matter while it's off
 * (the server keeps the choice for next time). Every change saves as it's
 * made. For an app whose Maximal integration is off, a warning stands in
 * for its checkbox and says why (the choice is kept for when it's back);
 * every app's name links to the Apps section, where that's managed.
 */
export function McpEndpointCard({
  endpoint,
  onToggle,
  onRefresh,
  onRemove,
}: McpEndpointCardProps): JSX.Element {
  // The change in flight, shown in place of the server's state so the
  // controls don't snap back for the seconds a broker restart takes.
  const [pending, setPending] = useState<Change | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // A save that didn't go through, and the change it was trying to make.
  const [failed, setFailed] = useState<{ problem: Problem; change: Change } | null>(null);
  const [skipped, setSkipped] = useState<McpEndpointToggleResponse["skipped"]>([]);
  const [adoptedFrom, setAdoptedFrom] = useState<string | undefined>();
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeFailed, setRemoveFailed] = useState<Problem | null>(null);

  const busy = pending !== null || removing;
  const enabled = pending?.enabled ?? endpoint.enabled;
  // Includes remembered choices for apps that can't be offered right now;
  // those ride along untouched on every save.
  const chosen = new Set(pending?.clients ?? endpoint.clients);
  const available = endpoint.offered.filter((client) => client.available);
  const checkedCount = available.filter((client) => chosen.has(client.id)).length;

  // Follows the switch: opens when it goes on, closes when it goes off. In
  // between, the twirldown lets the user fold the app list away.
  const [open, setOpen] = useState(enabled);
  useEffect(() => setOpen(enabled), [enabled]);
  const bodyId = useId();

  const save = async (change: Change): Promise<void> => {
    setPending(change);
    setFailed(null);
    const result = await onToggle(change.enabled, change.clients);
    setPending(null);
    if (!result.ok) {
      if (result.problem) setFailed({ problem: result.problem, change });
      return;
    }
    setSkipped(result.skipped ?? []);
    setAdoptedFrom(result.adoptedFrom);
  };

  const setChosen = (ids: Array<McpClientId>, checked: boolean): void => {
    const next = new Set(chosen);
    for (const id of ids) {
      if (checked) next.add(id);
      else next.delete(id);
    }
    void save({ enabled, clients: [...next] });
  };

  const remove = async (): Promise<void> => {
    setRemoving(true);
    setRemoveFailed(null);
    const result = await onRemove();
    setRemoving(false);
    setRemoveOpen(false);
    if (!result.ok && result.problem) setRemoveFailed(result.problem);
  };
  // Apps Maximal has it in now, named in the confirm.
  const addedTo = endpoint.offered.filter((client) => client.configured);

  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    setFailed(null);
    await onRefresh();
    setRefreshing(false);
  };

  // Why an app can't get the endpoint right now. Only reachable while the
  // card is open, i.e. while the endpoint is on.
  const unavailable = (client: McpClientOffer): string | undefined => {
    if (client.available) return undefined;
    return chosen.has(client.id)
      ? `${client.name}'s Maximal integration is off, so ${endpoint.label} isn't in it right now. It comes back when you turn ${client.name} on in Apps.`
      : `${client.name}'s Maximal integration is off. Turn it on in Apps to add ${endpoint.label} to it.`;
  };

  return (
    <article className="app-card mcp-card" data-mcp-endpoint={endpoint.id} aria-busy={busy}>
      <header className="app-card__head">
        <div className="mcp-card__title">
          <h3 className="app-card__name">{endpoint.label}</h3>
        </div>
        <div className="app-card__control">
          {busy && (
            <span className="mcp-card__saving" role="status">
              {removing ? "Removing…" : "Saving…"}
            </span>
          )}
          {refreshing && (
            <span className="mcp-card__saving" role="status">
              Refreshing…
            </span>
          )}
          <Button
            variant="ghost"
            className="btn--icon"
            aria-label={`Refresh ${endpoint.label}`}
            title="Refresh"
            disabled={refreshing || busy}
            onClick={() => void refresh()}
          >
            <RefreshIcon />
          </Button>
          <Button
            variant="ghost"
            className="btn--icon btn--ghost-destructive"
            aria-label={`Remove ${endpoint.label}`}
            title="Remove"
            disabled={refreshing || busy}
            onClick={() => setRemoveOpen(true)}
          >
            <TrashIcon />
          </Button>
          <Switch
            checked={enabled}
            disabled={busy}
            onCheckedChange={(next) => void save({ enabled: next, clients: [...chosen] })}
            label={enabled ? "On" : "Off"}
          />
          <Button
            variant="ghost"
            className="btn--icon mcp-card__twirl"
            aria-expanded={open}
            aria-controls={bodyId}
            aria-label={`${open ? "Hide" : "Show"} apps for ${endpoint.label}`}
            title={enabled ? undefined : `Turn ${endpoint.label} on to choose apps`}
            disabled={!enabled}
            onClick={() => setOpen((prev) => !prev)}
          >
            <ChevronIcon />
          </Button>
        </div>
      </header>

      <div className="mcp-card__body" id={bodyId} hidden={!open}>
        <fieldset className="mcp-card__apps" disabled={busy}>
          <legend className="sr-only">Apps that get {endpoint.label}</legend>
          <div className="mcp-card__row">
            <Checkbox
              label="All apps"
              hideLabel={false}
              checked={available.length > 0 && checkedCount === available.length}
              indeterminate={checkedCount > 0 && checkedCount < available.length}
              disabled={available.length === 0}
              onCheckedChange={(checked) =>
                setChosen(available.map((client) => client.id), checked)
              }
            />
          </div>
          {endpoint.offered.map((client) => (
            <div className="mcp-card__row mcp-card__row--app" key={client.id}>
              <LinkCheckbox
                label={client.name}
                href="#apps"
                checkboxLabel={`Add ${endpoint.label} to ${client.name}`}
                checked={chosen.has(client.id)}
                unavailable={unavailable(client)}
                onCheckedChange={(checked) => setChosen([client.id], checked)}
              />
            </div>
          ))}
        </fieldset>

        {enabled && !busy && adoptedFrom && (
          <p className="app-card__hint">
            Using the {endpoint.label} setup already in {adoptedFrom}.
          </p>
        )}

        {enabled &&
          !busy &&
          skipped.map((skip) => (
            <Callout tone="notice" title="Left your own setup in place" key={skip.client}>
              {skip.name} already has an MCP server named “{endpoint.id}”, so
              Maximal didn't change it.
            </Callout>
          ))}
      </div>

      <ConfirmDialog
        open={removeOpen}
        title={`Remove ${endpoint.label}?`}
        body={
          <p>
            {addedTo.length > 0
              ? `Maximal stops running it and takes it out of ${addedTo.map((client) => client.name).join(" and ")}.`
              : "Maximal stops running it."}{" "}
            Nothing is uninstalled; you can add it again later.
          </p>
        }
        confirmLabel="Remove"
        tone="danger"
        busy={removing}
        onConfirm={remove}
        onCancel={() => setRemoveOpen(false)}
      />

      {removeFailed && (
        <ProblemCallout
          problem={removeFailed}
          onRetry={() => void remove()}
          onRestarted={() => void refresh()}
        />
      )}

      {failed && (
        <ProblemCallout
          problem={failed.problem}
          onRetry={() => void save(failed.change)}
          onRestarted={() => void refresh()}
        />
      )}
    </article>
  );
}

function RefreshIcon(): JSX.Element {
  // lucide: refresh-cw
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </svg>
  );
}

function TrashIcon(): JSX.Element {
  // lucide: trash-2
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
      <line x1="10" x2="10" y1="11" y2="17" />
      <line x1="14" x2="14" y1="11" y2="17" />
    </svg>
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
