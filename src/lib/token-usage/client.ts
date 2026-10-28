import type { z } from "zod"

import { HELPER_LABEL } from "~/apps/claude-code/config"
import { DESKTOP_KEY_LABEL } from "~/apps/claude-desktop/config"
import { CODEX_KEY_LABEL } from "~/apps/codex/config"
import { classifyClaudeClient } from "~/lib/http/claude-client"

import type { SessionClient } from "./sessions-schema"

export type UsageClient = z.infer<typeof SessionClient>

/**
 * Which client sent a request. The API key label the integration provisioned
 * is the strongest signal; a renamed or shared key falls back to the Claude
 * user agent, and anything else is `other`.
 */
export function deriveUsageClient(
  label: string | null | undefined,
  userAgent: string,
): UsageClient {
  if (label === HELPER_LABEL) return "claude-code"
  if (label === DESKTOP_KEY_LABEL) return "claude-desktop"
  if (label === CODEX_KEY_LABEL) return "codex"

  const claude = classifyClaudeClient(userAgent)
  if (claude === "claude-code") return "claude-code"
  // Cowork runs inside Claude Desktop.
  if (claude === "claude-desktop" || claude === "cowork") {
    return "claude-desktop"
  }
  return "other"
}
