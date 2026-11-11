import { t } from "../../../i18n";

import { McpCatalogCard } from "./McpCatalogCard";
import { McpEndpointCard } from "./McpEndpointCard";
import { useMcp } from "./useMcp";
import type { McpBrokerHealth } from "../../../proxy/client";
import { Button } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { ProblemCallout } from "../../components/ProblemCallout";
import { Stack } from "../../components/Stack";
import type { Problem } from "../../problems";

/** Things Maximal is handling on its own: a quiet line, nothing to click. */
function quietLine(state: McpBrokerHealth["state"]): string | undefined {
  if (state === "starting") return t("mcp-broker-starting");
  if (state === "recovering") return t("mcp-broker-recovering");
  return undefined;
}

/** States that need the user, or at least an explanation. */
function brokerProblem(broker: McpBrokerHealth): Problem | null {
  if (broker.state === "stuck") {
    return {
      title: t("mcp-broker-stuck-title"),
      detail: t("mcp-broker-stuck-detail"),
      remedy: "restart",
      technical: "Broker state: circuit-open (restart budget used up)",
    };
  }
  if (broker.state === "unavailable" && broker.problem === "containment-unavailable") {
    // Windows refused the Job Object that ends the servers with Maximal.
    return {
      title: t("mcp-broker-uncontained-title"),
      detail: t("mcp-broker-uncontained-detail"),
      remedy: "none",
      technical: "MCP_BROKER_CONTAINMENT_UNAVAILABLE",
    };
  }
  if (broker.state === "unavailable") {
    return {
      title: t("mcp-broker-missing-title"),
      detail: t("mcp-broker-missing-detail"),
      remedy: "none",
      technical: "MCP_BROKER_EXECUTABLE_NOT_FOUND",
    };
  }
  return null;
}

export function McpPanel(): JSX.Element {
  const {
    endpoints,
    available,
    broker,
    isLoading,
    problem,
    refresh,
    toggle,
    add,
    remove,
    acceptWorkIqEula,
    signInWorkIq,
    cancelWorkIqSignIn,
  } = useMcp();
  const brokerIssue = broker ? brokerProblem(broker) : null;
  const quiet = broker ? quietLine(broker.state) : undefined;
  const canAdd = !problem;

  return (
    <Stack proximity="region" className="apps-panel" aria-busy={isLoading}>
      {problem && <ProblemCallout problem={problem} onRestarted={() => void refresh()} />}
      {!problem && brokerIssue && (
        <ProblemCallout problem={brokerIssue} onRestarted={() => void refresh()} />
      )}
      {!problem && quiet && (
        <p className="panel-status" role="status">
          {quiet}
        </p>
      )}

      {isLoading && endpoints.length === 0 ? (
        <p className="state__caption">Loading MCP servers…</p>
      ) : endpoints.length === 0 ? (
        // With known servers to add, those cards say what to do instead.
        canAdd &&
        available.length === 0 && (
          <EmptyState
            title="No MCP servers yet"
            action={
              <Button size="sm" onClick={() => void refresh()}>
                Check again
              </Button>
            }
          >
            <p>
              Add one under <code className="mono">mcpBroker.servers</code> in
              Maximal's config.json. It shows up here to turn on and share
              with your apps.
            </p>
          </EmptyState>
        )
      ) : (
        <Stack proximity="section" className="apps-list">
          {endpoints.map((endpoint) => (
            <McpEndpointCard
              key={endpoint.id}
              endpoint={endpoint}
              onRefresh={refresh}
              onToggle={(enabled, clients) =>
                toggle(endpoint.id, enabled, clients)
              }
              onRemove={() => remove(endpoint.id)}
              onAcceptWorkIqEula={() => acceptWorkIqEula(endpoint.id)}
              onSignInWorkIq={(useBrowserSignIn) => signInWorkIq(endpoint.id, useBrowserSignIn)}
              onCancelWorkIqSignIn={() => cancelWorkIqSignIn(endpoint.id)}
            />
          ))}
        </Stack>
      )}

      {canAdd && available.length > 0 && (
        <Stack proximity="section" className="subsection">
          <h3 className="subsection__title">Available to add</h3>
          <Stack proximity="section" className="apps-list">
            {available.map((item) => (
              <McpCatalogCard
                key={item.id}
                item={item}
                onAdd={() => add(item.id)}
                onRescan={refresh}
              />
            ))}
          </Stack>
        </Stack>
      )}
    </Stack>
  );
}
