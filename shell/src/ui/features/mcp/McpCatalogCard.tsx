import { useRef, useState } from "react";

import { t } from "../../../i18n";

import type { McpCatalogItem } from "../../../proxy/client";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ProblemCallout } from "../../components/ProblemCallout";
import type { Problem } from "../../problems";
import { useRecheckWhileVisible } from "../../recheck";

import type { McpMutationResult } from "./useMcp";

const COPIED_FLASH_MS = 1400;

interface McpCatalogCardProps {
  item: McpCatalogItem;
  onAdd: () => Promise<McpMutationResult>;
  /** Look for installed servers again. Must be a stable callback. */
  onRescan: () => Promise<void>;
}

/**
 * A known MCP server that isn't added yet, laid out like an Apps card.
 * Found on this machine: where it is, and Add (after a confirm, since
 * Maximal will run that program). Not found: the install command to copy
 * and which registry it downloads from; the card looks for the install on
 * its own and switches to Add when it appears. Adding leaves it off; its
 * endpoint card then takes over.
 */
export function McpCatalogCard({ item, onAdd, onRescan }: McpCatalogCardProps): JSX.Element {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [failed, setFailed] = useState<Problem | null>(null);
  const [copied, setCopied] = useState(false);
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

  const installRef = useRef<HTMLDivElement>(null);
  useRecheckWhileVisible(installRef, onRescan, !installed);

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
        <div className="app-card__install" ref={installRef}>
          <p className="app-card__hint">
            {t("install-run-in-terminal", { name: item.label })}
          </p>
          <div className="app-card__cmd">
            <code className="app-card__cmd-text mono">{item.install.command}</code>
            <div className="app-card__cmd-actions">
              <Button variant="primary" size="sm" onClick={() => void copyInstall()}>
                {copied ? t("common-copied") : t("apps-copy-command")}
              </Button>
            </div>
          </div>
          <p className="app-card__hint">
            {t("mcp-install-registry", { host: item.install.registry })}{" "}
            {t("mcp-install-then", { name: item.label })}
          </p>
        </div>
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
