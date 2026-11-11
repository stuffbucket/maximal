import { t } from "../../../i18n";
import type { PluginClientId, PluginClientView, PluginView } from "../../../proxy/client";

/** Product names, not translated. */
export const CLIENT_NAMES: Record<PluginClientId, string> = {
  "claude-code": "Claude Code",
};

type Standalone = NonNullable<PluginClientView["standalone"]>;

/** Why Maximal adds nothing to a client that already runs the connector itself. */
export function standaloneText(connector: string, clientId: PluginClientId, standalone: Standalone): string {
  return t(
    standalone.source === "plugin" ? "connectors-client-standalone-plugin" : "connectors-client-standalone-server",
    { connector, client: CLIENT_NAMES[clientId], name: standalone.name },
  );
}

/** The first client that already runs the connector itself, if any. */
export function standaloneClient(connector: PluginView): PluginClientView | undefined {
  return connector.clients.find((client) => client.standalone !== undefined);
}
