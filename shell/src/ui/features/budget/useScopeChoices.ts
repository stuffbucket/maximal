import { useEffect, useState } from "react";

import { apiCall, listPlugins } from "../../../proxy/client";

import { keyChoices, pluginChoices } from "./format";

/**
 * What a limit can apply to, listed only from things that exist: the client
 * keys and plugins Maximal knows about, then the clients and capabilities it
 * recognises on its own. Loaded when the editor opens; a failed read leaves
 * the built-in names, which are always valid.
 */
export function useScopeChoices(): { keys: Array<string>; plugins: Array<string> } {
  const [keys, setKeys] = useState<Array<string>>(() => keyChoices([]));
  const [plugins, setPlugins] = useState<Array<string>>(() => pluginChoices([]));

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [keyResult, pluginResult] = await Promise.all([
        apiCall({ kind: "api-keys-list", method: "GET", path: "/settings/api/api-keys" }),
        listPlugins(),
      ]);
      if (cancelled) return;
      if (keyResult.ok) setKeys(keyChoices(keyResult.data.entries.map((entry) => entry.label)));
      if (pluginResult.ok) setPlugins(pluginChoices(pluginResult.data.plugins.map((plugin) => plugin.id)));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { keys, plugins };
}
