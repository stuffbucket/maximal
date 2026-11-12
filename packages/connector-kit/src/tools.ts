import type {
  JsonSchemaObject,
  PluginLogger,
  ToolAnnotations,
  ToolCallContext,
  ToolDefinition,
  ToolResult,
} from "@stuffbucket/maximal-plugin-sdk"

import { TOOL_NAME_PATTERN } from "@stuffbucket/maximal-plugin-sdk"

import type { UpstreamTool } from "./upstream/connection"

export type ToolExecutor = (
  name: string,
  input: Record<string, unknown>,
  call: ToolCallContext,
) => Promise<ToolResult>

const HINTS = [
  "readOnlyHint",
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
] as const

function isObjectSchema(value: unknown): value is JsonSchemaObject {
  return (
    value !== null
    && typeof value === "object"
    && (value as { type?: unknown }).type === "object"
  )
}

function annotationsOf(tool: UpstreamTool): ToolAnnotations | undefined {
  const source = tool.annotations
  if (!source) return undefined
  const annotations: ToolAnnotations = {}
  if (typeof source.title === "string") annotations.title = source.title
  for (const hint of HINTS) {
    const value = source[hint]
    if (typeof value === "boolean") annotations[hint] = value
  }
  return Object.keys(annotations).length > 0 ? annotations : undefined
}

/**
 * Upstream `tools/list` → plugin tool definitions, verbatim (name, title,
 * description, schemas, annotations). Every `execute` forwards to
 * `tools/call` upstream. Tools the host contract cannot carry (invalid
 * name, non-object schema, duplicate) are skipped with a warning.
 */
export function mirrorTools(
  tools: ReadonlyArray<UpstreamTool>,
  execute: ToolExecutor,
  logger?: PluginLogger,
): Array<ToolDefinition> {
  const seen = new Set<string>()
  const definitions: Array<ToolDefinition> = []
  for (const tool of tools) {
    if (!TOOL_NAME_PATTERN.test(tool.name) || seen.has(tool.name)) {
      logger?.warn(
        `Skipping upstream tool ${JSON.stringify(tool.name)}: invalid or duplicate name.`,
      )
      continue
    }
    if (
      !isObjectSchema(tool.inputSchema)
      || (tool.outputSchema !== undefined && !isObjectSchema(tool.outputSchema))
    ) {
      logger?.warn(
        `Skipping upstream tool "${tool.name}": schemas must be JSON Schema objects.`,
      )
      continue
    }
    seen.add(tool.name)
    const name = tool.name
    const annotations = annotationsOf(tool)
    definitions.push({
      name,
      ...(tool.title === undefined ? {} : { title: tool.title }),
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema === undefined ?
        {}
      : { outputSchema: tool.outputSchema }),
      ...(annotations ? { annotations } : {}),
      execute: (input, call) => execute(name, input, call),
    })
  }
  return definitions
}
