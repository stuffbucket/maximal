/**
 * The Work IQ tool list the bench and tests serve: the tools Claude Desktop
 * showed for a Work IQ connector (`.claude/notes/claude-desktop-connectors.md`
 * §8), 12 captured plus 2 synthetic, grouped Read-only 6 / Write-delete 5 /
 * Other 3 by their annotations (`readOnlyHint` ⇒ read-only, else
 * `destructiveHint` ⇒ write/delete, else other).
 *
 * Provenance: names come from the captured titles (and agent-kit's list of
 * Work IQ server tools for the two synthetic ones). Descriptions are built
 * with `text(captured, synthetic)`: the first part is what the screenshots
 * showed, the second is invented to complete text the UI truncated. Input
 * names, required flags and descriptions follow the captured input panels;
 * inputs the captures did not show are marked `// synthetic`. Annotations
 * are chosen to reproduce the captured grouping — the real server's
 * annotations are unknown.
 */
import type { FakeTool } from "@stuffbucket/maximal-connector-kit/testing"

/** Captured text followed by a synthetic completion of what the UI truncated. */
function text(captured: string, synthetic = ""): string {
  return synthetic ? `${captured}${synthetic}` : captured
}

const agentId = {
  type: "string",
  description: "Optional agent ID to target a specific agent.",
}

const jsonBody = {
  description:
    "Structured JSON payload. Supply as a JSON object or JSON-encoded string.", // synthetic
  anyOf: [{ type: "object" }, { type: "string" }],
}

const headers = {
  type: ["object", "null"],
  description: "Optional HTTP headers, e.g. If-Match with an ETag.", // synthetic
  additionalProperties: { type: "string" },
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const
const WRITE = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: true,
} as const

/** Read-only tools (6). */
const READ_ONLY_TOOLS: Array<FakeTool> = [
  {
    name: "retrieve",
    description: text(
      "Search the user's M365 data (emails, files, meetings, Teams messages, people) and connected enterprise sources, returning raw per-source retrieval hits plus a model-friendly grounding markdown with inline [^id]",
      " citations that point at the hits.",
    ),
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to search for, in natural language.", // synthetic
        },
        includeDeveloperCard: {
          type: "boolean",
          description: "Include a developer card with retrieval diagnostics.", // synthetic
        },
        agentId,
        sources: {
          // synthetic input
          type: ["array", "null"],
          items: { type: "string" },
          description: "Limit retrieval to these sources (e.g. mail, files).",
        },
        top: {
          // synthetic input
          type: "integer",
          description: "Most hits to return per source.",
        },
      },
      required: ["query"],
    },
    annotations: READ_ONLY,
  },
  {
    name: "fetch_blob",
    description: text(
      "Fetch a binary file (document, image, photo) from a WorkIQ path — PDFs, Office files, profile photos, etc. Up to 4 MB for the raw file. Returns the file's bytes base64-encoded plus metadata. To read the file, decode th",
      "e bytes or ask for a text format.",
    ),
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "WorkIQ path of the file." }, // synthetic description
        format: {
          type: "string",
          description: "Optional conversion, e.g. pdf.", // synthetic description
        },
        agentId,
      },
      required: ["path"],
    },
    annotations: READ_ONLY,
  },
  {
    name: "get_schema",
    description: text(
      "Get the request/response schema for a WorkIQ path and operation (CDDL by default; 'jsonschema' or 'typescript' on request). Only needed when you do not know the fields for a write, or a write returned 400.",
      " Reads never need it.",
    ),
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "WorkIQ path." }, // synthetic description
        operationType: {
          type: "string",
          enum: ["fetch", "create", "update", "action"], // from agent-kit
          description: "Operation the schema is for.", // synthetic description
        },
        format: {
          type: "string",
          enum: ["cddl", "jsonschema", "typescript"],
          description: "Schema notation (default cddl).", // synthetic description
        },
        agentId, // synthetic: the fourth input was not captured
      },
      required: ["path", "operationType"],
    },
    annotations: READ_ONLY,
  },
  {
    name: "call_function",
    description: text(
      "Call a read-only WorkIQ function. Graph functions use HTTP GET; provider functions may accept structured JSON parameters. Functions compute or synthesize data rather than simply reading entities — e.g., delta",
      " queries, reminder views and searches.",
    ),
    inputSchema: {
      type: "object",
      properties: {
        functionUrl: {
          type: "string",
          description:
            "WorkIQ function path to call (e.g., /me/messages/delta(), /me/drive/root/search(q='budget'), /me/reminderView(startDateTime='...',endDateTime='...')). Must be a relative path — do not include a base URL.",
        },
        agentId,
        jsonBody: {
          description:
            "OPTIONAL — structured parameters for a provider function. Available only when enabled for the caller. Supply as a JSON object or JSON-encoded string.",
          anyOf: [{ type: "object" }, { type: "string" }],
        },
      },
      required: ["functionUrl"],
    },
    annotations: READ_ONLY,
  },
  {
    name: "fetch",
    description: text(
      "Fetch one or more WorkIQ entities by path. Use well-known Microsoft Graph paths directly, e.g. /me/messages, /me/events/{id}, /me/calendarView?startDateTime=...&endDateTime=..., /me/manager,",
      " /me/drive/items/{id}. Returns one result per path, in order.",
    ),
    inputSchema: {
      type: "object",
      properties: {
        entityUrls: {
          type: "array",
          items: { type: "string" },
          description: "Relative WorkIQ entity paths to read.", // synthetic description
        },
        agentId,
      },
      required: ["entityUrls"],
    },
    annotations: READ_ONLY,
  },
  {
    // synthetic tool: the sixth read-only tool was not captured; the name is
    // one agent-kit calls on the Work IQ server.
    name: "search_paths",
    description: text(
      "",
      "Search the catalog of WorkIQ paths the service allows, by keyword or path prefix. Use it to find the right path before calling fetch.",
    ),
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords to search for." },
        filter: { type: "string", description: "Path prefix filter." },
        agentId,
      },
    },
    annotations: READ_ONLY,
  },
]

/** Write/delete tools (5). */
const WRITE_TOOLS: Array<FakeTool> = [
  {
    name: "accept_eula",
    description: text(
      "Accept the End User License Agreement (EULA) to enable full access to WorkIQ tools. The EULA URL should be https://github.com/microsoft/work-iq. This action requires explicit user confirmation and cannot be",
      " undone from this tool.",
    ),
    inputSchema: {
      type: "object",
      properties: {
        eulaUrl: {
          type: "string",
          description: "URL of the EULA being accepted.", // synthetic description
        },
      },
      required: ["eulaUrl"],
    },
    annotations: WRITE,
  },
  {
    name: "delete_entity",
    description: text(
      "Delete a WorkIQ entity by path. Sends HTTP DELETE to the entity path. Returns confirmation with status code on success. WorkIQ entity paths borrow from the conventions of Microsoft Graph. If the path or ID is",
      " unknown, fetch the parent collection first.",
    ),
    inputSchema: {
      type: "object",
      properties: {
        entityUrl: {
          type: "string",
          description: "Relative path of the entity to delete.", // synthetic description
        },
        headers,
        agentId,
      },
      required: ["entityUrl"],
    },
    annotations: WRITE,
  },
  {
    // synthetic tool: the third write/delete tool was not captured; the name
    // is one agent-kit lists on the Work IQ server.
    name: "upload_blob",
    description: text(
      "",
      "Upload a file (up to 4 MB) to a WorkIQ drive path. Send the bytes base64-encoded; returns the created item's metadata.",
    ),
    inputSchema: {
      type: "object",
      properties: {
        parentUrl: {
          type: "string",
          description: "Folder path to upload into.",
        },
        fileName: { type: "string", description: "Name of the new file." },
        contentBase64: { type: "string", description: "File bytes, base64." },
        agentId,
      },
      required: ["parentUrl", "fileName", "contentBase64"],
    },
    annotations: WRITE,
  },
  {
    name: "create_entity",
    description: text(
      "Create a new WorkIQ entity by POSTing JSON to a parent collection path. Call it directly for standard Graph payloads (e.g. event subject/start/end, message subject/body/toRecipients, mailFolder displayName, conta",
      "ct names); use get_schema only if a create returned 400.",
    ),
    inputSchema: {
      type: "object",
      properties: {
        parentUrl: {
          type: "string",
          description: "Relative path of the parent collection.", // synthetic description
        },
        jsonBody,
        agentId,
      },
      required: ["parentUrl", "jsonBody"],
    },
    annotations: WRITE,
  },
  {
    name: "update_entity",
    description: text(
      "Update an existing WorkIQ entity by writing JSON to its path. Call it directly for standard fields (e.g. isRead, flag, subject, location, start/end, displayName); use get_schema only if you do not know the fields or the",
      " update returned 400.",
    ),
    inputSchema: {
      type: "object",
      properties: {
        entityUrl: {
          type: "string",
          description: "Relative path of the entity to update.", // synthetic description
        },
        jsonBody,
        headers,
        agentId, // synthetic: the fourth input was not captured
      },
      required: ["entityUrl", "jsonBody"],
    },
    annotations: WRITE,
  },
]

/** Other tools (3) — neither hint set to true. */
const OTHER_TOOLS: Array<FakeTool> = [
  {
    name: "ask",
    description:
      "Ask a question to Microsoft 365 Copilot for information about emails, meetings, files, and other M365 data. Returns the answer as text content, with conversationId in structured content for multi-turn conversations.",
    inputSchema: {
      type: "object",
      properties: {
        question: { description: "The question to ask", type: "string" },
        fileUrls: {
          description:
            "Optional list of OneDrive or SharePoint file URLs to use as context",
          type: ["array", "null"],
          items: { type: ["string", "null"] },
        },
        conversationId: {
          description:
            "Optional conversation ID to continue an existing conversation",
          type: "string",
        },
        agentId: {
          description:
            "Optional agent ID to target a specific agent. Defaults to M365 Copilot.",
          type: "string",
        },
      },
      required: ["question"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "list_agents",
    description:
      "List available Microsoft 365 Copilot agents. Returns agent IDs that can be passed to ask's agentId parameter.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_debug_link",
    description: text(
      "Generates a share or debug link for a Work IQ conversation after requesting explicit user confirmation through the MCP host. Requires a host that supports form elicitation and obtains the human's response;",
      " returns the link as text.",
    ),
    inputSchema: {
      type: "object",
      properties: {
        linkType: {
          type: "string",
          enum: ["share", "debug"], // synthetic values
          description: "Kind of link to create.", // synthetic description
        },
        conversationId: {
          type: "string",
          description: "Conversation to link to.", // synthetic description
        },
      },
      required: ["linkType", "conversationId"],
    },
    annotations: { destructiveHint: false },
  },
]

/** All 14 tools in the order Claude Desktop listed them, group by group. */
export const WORKIQ_TOOLS: Array<FakeTool> = [
  ...READ_ONLY_TOOLS,
  ...WRITE_TOOLS,
  ...OTHER_TOOLS,
]

/** The two tools the captures did not show (invented). */
export const SYNTHETIC_TOOL_NAMES: ReadonlyArray<string> = [
  "search_paths",
  "upload_blob",
]
