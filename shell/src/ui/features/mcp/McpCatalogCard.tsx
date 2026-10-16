import { useState } from "react";

import type { McpCatalogItem } from "../../../proxy/client";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ProblemCallout } from "../../components/ProblemCallout";
import type { Problem } from "../../problems";

import type { McpMutationResult } from "./useMcp";

const COPIED_FLASH_MS = 1400;

interface McpCatalogCardProps {
  item: McpCatalogItem;
  onAdd: () => Promise<McpMutationResult>;
  /** Look for installed servers again. */
  onRescan: () => Promise<void>;
}

/**
 * A known MCP server that isn't added yet, laid out like an Apps card.
 * Found on this machine: where it is, and Add (after a confirm, since
 * Maximal will run that program). Not found: the install command to copy
 * and a re-scan. Adding leaves it off; its endpoint card then takes over.
 */
export function McpCatalogCard({ item, onAdd, onRescan }: McpCatalogCardProps): JSX.Element {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [failed, setFailed] = useState<Problem | null>(null);
  const [copied, setCopied] = useState(false);
  const [rescanning, setRescanning] = useState(false);
  const installed = item.status === "ready";

  const add = async (): Promise<void> => {
    setAdding(true);
    setFailed(null);
    const result = await onAdd();
    setAdding(false);
    setConfirmOpen(false);
    if (!result.ok && result.problem) setFailed(result.problem);
  };

  const copyInstall = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(item.install.command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), COPIED_FLASH_MS);
    } catch {
      // Clipboard unavailable; the command is shown to select by hand.
    }
  };

  const rescan = async (): Promise<void> => {
    setRescanning(true);
    await onRescan();
    setRescanning(false);
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
        <div className="app-card__install">
          <p className="app-card__hint">
            Run this in your terminal to install {item.label}, then re-scan.
          </p>
          <div className="app-card__cmd">
            <code className="app-card__cmd-text mono">{item.install.command}</code>
            <div className="app-card__cmd-actions">
              <Button variant="primary" size="sm" onClick={() => void copyInstall()}>
                {copied ? "Copied" : "Copy command"}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={rescanning}
                onClick={() => void rescan()}
              >
                {rescanning ? "Re-scanning…" : "Re-scan"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {failed && <ProblemCallout problem={failed} onRestarted={() => void rescan()} />}

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
