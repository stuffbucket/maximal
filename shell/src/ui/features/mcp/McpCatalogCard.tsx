import { useState } from "react";

import type { McpCatalogItem } from "../../../proxy/client";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { InstallSteps } from "../../components/InstallSteps";
import { ProblemCallout } from "../../components/ProblemCallout";
import type { Problem } from "../../problems";

import type { McpMutationResult } from "./useMcp";

interface McpCatalogCardProps {
  item: McpCatalogItem;
  onAdd: () => Promise<McpMutationResult>;
  /** Look for installed servers again. */
  onRescan: () => Promise<void>;
}

/**
 * A known MCP server that isn't added yet, laid out like an Apps card.
 * Found on this machine: where it is, and Add (after a confirm, since
 * Maximal will run that program). Not found: the steps to install it, and
 * the card turns into the found one by itself once it is. Adding leaves it
 * off; its endpoint card then takes over.
 */
export function McpCatalogCard({ item, onAdd, onRescan }: McpCatalogCardProps): JSX.Element {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [failed, setFailed] = useState<Problem | null>(null);
  const installed = item.status === "ready";

  const add = async (): Promise<void> => {
    setAdding(true);
    setFailed(null);
    const result = await onAdd();
    setAdding(false);
    setConfirmOpen(false);
    if (!result.ok && result.problem) setFailed(result.problem);
  };

  return (
    <article className="app-card" data-mcp-catalog={item.id} aria-busy={adding}>
      <header className="app-card__head">
        {/* Under the "Available to add" heading, so one level down. */}
        <h4 className="app-card__name">{item.label}</h4>
        <div className="app-card__control">
          {installed && (
            <Button variant="primary" size="sm" onClick={() => setConfirmOpen(true)}>
              Add
            </Button>
          )}
        </div>
      </header>

      {installed ? (
        <p className="app-card__hint mono">{item.command}</p>
      ) : (
        <InstallSteps
          name={item.label}
          command={item.install.command}
          connectTitle={`Connect Maximal to ${item.label}`}
          connectHint="Then add it here."
          onCheck={onRescan}
        />
      )}

      {failed && <ProblemCallout problem={failed} onRestarted={() => void onRescan()} />}

      {installed && (
        <ConfirmDialog
          open={confirmOpen}
          title={`Add ${item.label}?`}
          body={
            <>
              <p>
                Maximal will run <code className="mono">{item.command}</code>{" "}
                for the apps you choose.
              </p>
              <p>It starts off. Turn it on to choose which apps get it.</p>
            </>
          }
          confirmLabel="Add"
          busy={adding}
          onConfirm={add}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </article>
  );
}
