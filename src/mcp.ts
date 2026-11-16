import type { CommandDef } from "citty"

import { defineCommand } from "citty"

import {
  MCP_STDIO_SUBCOMMAND,
  MCP_STDIO_URL_FLAG,
} from "~/lib/mcp-stdio/command"

const stdioCommand = defineCommand({
  meta: {
    name: MCP_STDIO_SUBCOMMAND,
    description:
      "Bridge MCP over stdio to Maximal's loopback Streamable HTTP endpoint.",
  },
  args: {
    url: {
      type: "string",
      required: true,
      description: "Maximal aggregate endpoint (http://127.0.0.1:<port>/mcp).",
    },
  },
  async run({ args }) {
    const { runMcpStdioFromArgv } = await import("~/lib/mcp-stdio/adapter")
    const exitCode = await runMcpStdioFromArgv(
      [MCP_STDIO_URL_FLAG, args.url],
      process.env,
    )
    process.exit(exitCode)
  },
})

export const mcpCommand: CommandDef = defineCommand({
  meta: {
    name: "mcp",
    description: "MCP transport utilities.",
  },
  subCommands: {
    [MCP_STDIO_SUBCOMMAND]: stdioCommand,
  },
})
