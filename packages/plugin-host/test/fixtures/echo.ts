import type { Context, PluginMeta } from "@stuffbucket/maximal-plugin-sdk"

// A complete plugin written exactly as a plugin package would be.
import { z } from "zod"

export const name = "echo"
export const meta: PluginMeta = {
  displayName: "Echo",
  description: "Echoes its input.",
}
export const inject = ["tools", "surface", "storage"] as const
export const Config = z.object({ prefix: z.string().default("echo") })
export type Config = z.output<typeof Config>

export function apply(ctx: Context, config: Config): void {
  const lifecycle = new AbortController()
  const stop = () => lifecycle.abort()
  ctx.effect(() => stop, "echo lifecycle")
  ctx.surface.setStatus({
    state: "ready",
    code: "ready",
    summary: `Prefix: ${config.prefix}`,
  })
  ctx.tools.register({
    name: "echo",
    description: "Echo the text back.",
    inputSchema: z.toJSONSchema(z.object({ text: z.string() })) as {
      type: "object"
    },
    annotations: { readOnlyHint: true },
    async execute(input) {
      const text = `${config.prefix}: ${String(input.text)}`
      await ctx.storage.writeText("last.txt", text)
      return { content: [{ type: "text", text }] }
    },
  })
}
