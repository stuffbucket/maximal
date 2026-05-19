import { useCallback, useEffect, useState } from "react";

import { apiCall } from "../../api";
import type { ApiKeyEntry } from "../../../../src/lib/settings-types";
import { humanize } from "./humanize";

/**
 * Data hook over `/settings/api/api-keys`. Owns the entries list, the
 * `enforcing` flag, loading + error state, and the four mutation
 * verbs the UI needs.
 *
 * Each mutation returns `{ ok: boolean; error?: string }` so the
 * caller can decide whether to clear a draft / advance focus / etc.
 * without re-reading the list. We still call `reload()` after every
 * successful mutation — there's no optimistic update; the wire is
 * fast enough on loopback that the resulting flicker is negligible.
 */
export interface UseApiKeys {
  entries: Array<ApiKeyEntry>;
  enforcing: boolean;
  isLoading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  create: (input: {
    label: string;
    key?: string;
    enabled?: boolean;
  }) => Promise<MutationResult>;
  update: (
    id: string,
    patch: { label?: string; key?: string; enabled?: boolean },
  ) => Promise<MutationResult>;
  remove: (id: string) => Promise<MutationResult>;
}

export interface MutationResult {
  ok: boolean;
  error?: string;
}

export function useApiKeys(): UseApiKeys {
  const [entries, setEntries] = useState<Array<ApiKeyEntry>>([]);
  const [enforcing, setEnforcing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const result = await apiCall({
      kind: "api-keys-list",
      method: "GET",
      path: "/settings/api/api-keys",
    });
    if (result.ok) {
      setEntries(result.data.entries);
      setEnforcing(result.data.enforcing);
      setError(null);
    } else {
      setError(humanize(result.error));
    }
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const create = useCallback<UseApiKeys["create"]>(
    async (input) => {
      const result = await apiCall({
        kind: "api-keys-create",
        method: "POST",
        path: "/settings/api/api-keys",
        body: input,
      });
      if (!result.ok) {
        const message = humanize(result.error);
        setError(message);
        return { ok: false, error: message };
      }
      setError(null);
      await reload();
      return { ok: true };
    },
    [reload],
  );

  const update = useCallback<UseApiKeys["update"]>(
    async (id, patch) => {
      const result = await apiCall({
        kind: "api-keys-update",
        method: "PATCH",
        path: `/settings/api/api-keys/${id}`,
        body: patch,
      });
      if (!result.ok) {
        const message = humanize(result.error);
        setError(message);
        return { ok: false, error: message };
      }
      setError(null);
      await reload();
      return { ok: true };
    },
    [reload],
  );

  const remove = useCallback<UseApiKeys["remove"]>(
    async (id) => {
      const result = await apiCall({
        kind: "api-keys-delete",
        method: "DELETE",
        path: `/settings/api/api-keys/${id}`,
      });
      if (!result.ok) {
        const message = humanize(result.error);
        setError(message);
        return { ok: false, error: message };
      }
      setError(null);
      // Deliberately do NOT reload here — bulk delete fans out N calls
      // and only the last should trigger a refresh. The caller decides.
      return { ok: true };
    },
    [],
  );

  return {
    entries,
    enforcing,
    isLoading,
    error,
    reload,
    create,
    update,
    remove,
  };
}
