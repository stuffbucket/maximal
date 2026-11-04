/**
 * Canned, clearly fake answers for the Work IQ fixture tools. Every value
 * is made up (contoso.com, "(fake)", zero GUIDs); nothing comes from a real
 * tenant.
 */
import type { CannedResult } from "@stuffbucket/maximal-connector-kit/testing"

const FAKE_ID = "00000000-0000-4000-8000-0000000000f1"

function json(value: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError } : {}),
  }
}

function paths(args: Record<string, unknown>): Array<string> {
  const urls = args.entityUrls
  return Array.isArray(urls) ?
      urls.filter((url): url is string => typeof url === "string")
    : []
}

export const WORKIQ_RESULTS: Record<string, CannedResult> = {
  retrieve: (args) => ({
    content: [
      {
        type: "text",
        text: `Fake grounding for "${String(args.query)}": Ada Lovelace (fake) shared the Q3 plan in Teams [^1].\n\n[^1]: Teams message, contoso.com (fake)`,
      },
    ],
    structuredContent: {
      hits: [
        {
          id: "1",
          source: "teams",
          title: "Q3 plan (fake)",
          url: "https://contoso.example/teams/fake",
        },
      ],
    },
  }),
  fetch_blob: (args) =>
    json({
      path: args.path,
      contentType: "text/plain",
      size: 9,
      contentBase64: Buffer.from("fake file").toString("base64"),
    }),
  get_schema: (args) => ({
    content: [
      {
        type: "text",
        text: `; fake CDDL for ${String(args.operationType)} ${String(args.path)}\nentity = { subject: tstr, ? body: tstr }`,
      },
    ],
  }),
  call_function: (args) =>
    json({
      statusCode: 200,
      data: {
        value: [],
        "@odata.deltaLink": `${String(args.functionUrl)}?token=fake`,
      },
      error: null,
    }),
  fetch: (args) =>
    json({
      results: paths(args).map((path) => ({
        statusCode: 200,
        data: {
          id: FAKE_ID,
          path,
          displayName: "Ada Lovelace (fake)",
          mail: "ada@contoso.com",
        },
        error: null,
      })),
    }),
  search_paths: (args) =>
    json({
      paths: [
        { path: "/me/messages", operations: ["fetch"] },
        { path: "/me/events", operations: ["fetch", "create"] },
      ],
      query: args.query ?? args.filter ?? "",
    }),
  accept_eula: (args) =>
    json({ accepted: true, eulaUrl: args.eulaUrl, note: "fake acceptance" }),
  delete_entity: (args) =>
    json({ statusCode: 204, deleted: args.entityUrl, note: "fake delete" }),
  upload_blob: (args) =>
    json({
      statusCode: 201,
      data: { id: FAKE_ID, name: args.fileName, note: "fake upload" },
    }),
  create_entity: (args) =>
    json({
      statusCode: 201,
      data: { id: FAKE_ID, parent: args.parentUrl, note: "fake create" },
    }),
  update_entity: (args) =>
    json({ statusCode: 200, updated: args.entityUrl, note: "fake update" }),
  ask: (args) => ({
    content: [
      {
        type: "text",
        text: `This is a canned answer from the fake Work IQ server to: ${String(args.question)}`,
      },
    ],
    structuredContent: { conversationId: FAKE_ID },
  }),
  list_agents: () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify([
          {
            agentId: "fake-agent-1",
            name: "Researcher (fake)",
            provider: "Microsoft",
          },
        ]),
      },
    ],
  }),
  get_debug_link: (args) => ({
    content: [
      {
        type: "text",
        text: `https://example.invalid/workiq/${String(args.linkType)}/${String(args.conversationId)}`,
      },
    ],
  }),
}
