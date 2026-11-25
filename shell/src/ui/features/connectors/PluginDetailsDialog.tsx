import { useId, useRef } from "react";

import type { PluginView } from "../../../proxy/client";
import { ModalDialog } from "../../components/ModalDialog";

import { ConnectorDetail } from "./ConnectorDetail";

interface PluginDetailsDialogProps {
  plugin: PluginView | null;
  version: number;
  onFresh: (plugin: PluginView) => void;
  onDismiss: () => void;
}

/**
 * Large, reusable Cordis plugin detail surface. The list remains mounted behind
 * the native modal while the plugin-specific status, actions, tools, and config
 * render in one internally scrolling body.
 */
export function PluginDetailsDialog({
  plugin,
  version,
  onFresh,
  onDismiss,
}: PluginDetailsDialogProps): JSX.Element {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const headingId = useId();

  return (
    <ModalDialog
      open={plugin !== null}
      className="plugin-details-dialog"
      ariaLabelledBy={plugin ? headingId : undefined}
      initialFocusRef={headingRef}
      onDismiss={onDismiss}
    >
      {plugin && (
        <ConnectorDetail
          key={plugin.id}
          summary={plugin}
          version={version}
          headingId={headingId}
          headingRef={headingRef}
          onFresh={onFresh}
          onDismiss={onDismiss}
        />
      )}
    </ModalDialog>
  );
}
