import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  type PluginDetailView,
  type PluginUpdateRequest,
  type PluginValidationIssue,
  type PluginView,
  type ToolPermission,
  getPlugin,
  pluginValidationIssues,
  runPluginAction,
  setToolPermissions,
  updatePlugin,
} from "../../../proxy/client";
import { type Problem, describeProblem, withRetry } from "../../problems";

import type { ConnectorMutationResult } from "./useConnectors";

export interface ConnectorUpdateResult extends ConnectorMutationResult {
  /** The connector rejected the body (usually its config), field by field. */
  issues?: Array<PluginValidationIssue>;
}

interface UseConnectorDetail {
  /** The server's copy with any permission change still in flight applied. */
  detail: PluginDetailView | null;
  isLoading: boolean;
  problem: Problem | null;
  reload: () => Promise<void>;
  update: (change: PluginUpdateRequest) => Promise<ConnectorUpdateResult>;
  /** Optimistic: the controls move at once and roll back if the save fails. */
  setPermissions: (changes: Record<string, ToolPermission>) => Promise<ConnectorMutationResult>;
  runAction: (actionId: string) => Promise<ConnectorMutationResult>;
}

/**
 * One connector's detail over `GET /settings/api/plugins/:id`. Refetches
 * whenever `version` moves (the list hook bumps it on every server nudge),
 * and folds each mutation's reply into the list through `onFresh`.
 */
export function useConnectorDetail(
  id: string,
  version: number,
  onFresh: (connector: PluginView) => void,
): UseConnectorDetail {
  const [server, setServer] = useState<PluginDetailView | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [problem, setProblem] = useState<Problem | null>(null);
  // Permission changes not yet confirmed, by tool name, tagged with the
  // request that set them so an older reply can't clear a newer click.
  const [pending, setPending] = useState<Record<string, { value: ToolPermission; seq: number }>>({});
  const seq = useRef(0);
  const onFreshRef = useRef(onFresh);
  onFreshRef.current = onFresh;

  const accept = useCallback((fresh: PluginDetailView) => {
    setServer(fresh);
    onFreshRef.current(fresh);
  }, []);

  const reload = useCallback(async () => {
    const result = await withRetry(() => getPlugin(id));
    if (result.ok) {
      setServer(result.data);
      setProblem(null);
    } else {
      setProblem(describeProblem(result, { subject: "this connector" }));
    }
    setIsLoading(false);
  }, [id]);

  useEffect(() => {
    void reload();
  }, [reload, version]);

  const update = useCallback<UseConnectorDetail["update"]>(
    async (change) => {
      const result = await updatePlugin(id, change);
      if (!result.ok) {
        return {
          ok: false,
          issues: pluginValidationIssues(result) ?? undefined,
          problem: describeProblem(result, { subject: "this connector", doing: "save" }),
        };
      }
      accept(result.data);
      return { ok: true };
    },
    [id, accept],
  );

  const setPermissions = useCallback<UseConnectorDetail["setPermissions"]>(
    async (changes) => {
      const mine = ++seq.current;
      setPending((prev) => {
        const next = { ...prev };
        for (const [name, value] of Object.entries(changes)) next[name] = { value, seq: mine };
        return next;
      });
      const result = await setToolPermissions(id, changes);
      // Drop this request's overrides either way: on success the reply
      // carries them, on failure the server's value shows again.
      setPending((prev) => {
        const next = { ...prev };
        for (const name of Object.keys(changes)) {
          if (next[name]?.seq === mine) delete next[name];
        }
        return next;
      });
      if (!result.ok) {
        return {
          ok: false,
          problem: describeProblem(result, { subject: "this connector", doing: "save" }),
        };
      }
      accept(result.data);
      return { ok: true };
    },
    [id, accept],
  );

  const runAction = useCallback<UseConnectorDetail["runAction"]>(
    async (actionId) => {
      const result = await runPluginAction(id, actionId);
      if (!result.ok) {
        return {
          ok: false,
          problem: describeProblem(result, { subject: "this connector", doing: "save" }),
        };
      }
      // Under way; the outcome arrives as a status change (plugins.changed).
      void reload();
      return { ok: true };
    },
    [id, reload],
  );

  const detail = useMemo(() => {
    if (!server || Object.keys(pending).length === 0) return server;
    return {
      ...server,
      tools: server.tools.map((tool) =>
        pending[tool.name] ? { ...tool, permission: pending[tool.name].value } : tool,
      ),
    };
  }, [server, pending]);

  return { detail, isLoading, problem, reload, update, setPermissions, runAction };
}
