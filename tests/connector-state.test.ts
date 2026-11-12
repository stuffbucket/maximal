import { describe, expect, test } from "bun:test"

import type { PluginView } from "../src/lib/config/settings-types"

import { t } from "../shell/src/i18n"
import {
  connectorIdFromHash,
  connectorLine,
  listStatus,
} from "../shell/src/ui/features/connectors/connector-state"

const WAITING_CONNECTOR = {
  id: "waiting-connector",
  kind: "connector",
  source: "built-in",
  displayName: "Waiting connector",
  description: "A connector waiting for a service.",
  manifest: {
    id: "waiting-connector",
    kind: "connector",
    displayName: "Waiting connector",
    description: "A connector waiting for a service.",
  },
  enabled: true,
  lifecycle: "waiting",
  waitingForServices: ["catalog"],
  toolCounts: {
    total: 0,
    byGroup: { "read-only": 0, "write-delete": 0, other: 0 },
  },
  toolsSource: "none",
  clients: [],
  endpoint: "/mcp/waiting-connector",
} satisfies PluginView

function waitingConnector(extra: Partial<PluginView> = {}): PluginView {
  return { ...WAITING_CONNECTOR, ...extra }
}

describe("connector detail deep links", () => {
  test("decodes a plugin id and rejects absent or malformed ids", () => {
    expect(connectorIdFromHash("#connectors/work%20iq")).toBe("work iq")
    expect(connectorIdFromHash("#connectors")).toBeNull()
    expect(connectorIdFromHash("#connectors/")).toBeNull()
    expect(connectorIdFromHash("#connectors/%")).toBeNull()
  })
})

describe("a waiting connector", () => {
  test("shows its waiting reason instead of a running status", () => {
    const result = connectorLine(
      waitingConnector({
        waitingReason: "Waiting for required service: catalog.",
        status: { state: "ready", code: "ready", summary: "Running" },
      }),
    )

    expect(result).toEqual({
      tone: "needs-setup",
      toneLabel: t("connectors-status-needs-setup"),
      text: "Waiting for required service: catalog.",
    })
  })

  test("uses the existing needs-setup wording without a reason", () => {
    expect(connectorLine(waitingConnector())).toEqual({
      tone: "needs-setup",
      toneLabel: t("connectors-status-needs-setup"),
      text: t("connectors-status-needs-setup"),
    })
  })

  test("never appears ready in the connector list", () => {
    expect(
      listStatus(
        waitingConnector({
          status: { state: "ready", code: "ready", summary: "Running" },
        }),
      ),
    ).toEqual({
      kind: "dot",
      tone: "needs-setup",
      label: t("connectors-status-needs-setup"),
    })
  })
})
