import type { Client, Progress } from "@modelcontextprotocol/client"
import type { Server } from "@modelcontextprotocol/server"

export function installInputRequiredToolForwarder({
  client,
  requestTimeout,
  server,
}: {
  client: Client
  requestTimeout?: number
  server: Server
}): void {
  server.setRequestHandler("tools/call", async (request, ctx) => {
    const progressToken = ctx.mcpReq._meta?.progressToken
    const inputResponses = ctx.mcpReq.inputResponses
    const requestState = ctx.mcpReq.requestState<string>()
    const params = {
      ...request.params,
      ...(inputResponses === undefined ? {} : { inputResponses }),
      ...(requestState === undefined ? {} : { requestState }),
    }
    const result = await client.callTool(params, {
      allowInputRequired: true,
      ...(progressToken === undefined ?
        {}
      : {
          onprogress: (progress: Progress) => {
            void ctx.mcpReq
              .notify({
                method: "notifications/progress",
                params: { ...progress, progressToken },
              })
              .catch(() => {
                console.error("[spike] progress forwarding failed")
              })
          },
        }),
      signal: ctx.mcpReq.signal,
      ...(requestTimeout === undefined ? {} : { timeout: requestTimeout }),
    })

    // callTool's overload remains typed as complete-only even when the documented
    // allowInputRequired option returns the neutral MRTR result to manual callers.
    return result
  })
}
