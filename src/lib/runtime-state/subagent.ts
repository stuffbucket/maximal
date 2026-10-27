import { z } from "zod"

export const subagentMarkerPrefix = "__SUBAGENT_MARKER__"

export const SubagentMarkerSchema = z.object({
  session_id: z.string().min(1),
  agent_id: z.string().min(1),
  agent_type: z.string().min(1),
})

export type SubagentMarker = z.infer<typeof SubagentMarkerSchema>
