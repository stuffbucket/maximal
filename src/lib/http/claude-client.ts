/**
 * Which of Claude's agent apps sent a request. Claude Code, Claude Desktop
 * (its Code tab and 3P mode) and Cowork all run the same agent and send
 *
 *   claude-cli/<version> (external, <entrypoint>[, ...])
 *
 * where the entrypoint names the app. Older Claude Code builds sent
 * `claude-code/<version>`. One classifier, so labelling (Active clients) and
 * behavior (Claude-specific request fixes) can't disagree on who's calling.
 */

export type ClaudeClient = "claude-code" | "claude-desktop" | "cowork"

const CLAUDE_AGENT_USER_AGENT =
  /^(?:claude-cli|claude-code)\/\S+(?:\s+\(external,\s*([\w.-]+))?/iu

// A Map, not an object literal: an entrypoint like `constructor` must not
// resolve through the prototype.
const CLIENT_BY_ENTRYPOINT: ReadonlyMap<string, ClaudeClient> = new Map([
  ["claude-desktop", "claude-desktop"],
  ["claude-desktop-3p", "claude-desktop"],
  ["local-agent", "cowork"],
])

/** The Claude app behind `userAgent`, or `null` for anything else. An
 *  unrecognised entrypoint (`cli`, `sdk-ts`, …) is Claude Code itself. */
export function classifyClaudeClient(
  userAgent: string | undefined,
): ClaudeClient | null {
  const match = CLAUDE_AGENT_USER_AGENT.exec(userAgent?.trim() ?? "")
  if (!match) return null
  // The entrypoint group is absent from older and bare user agents.
  const [, entrypoint = ""] = match as Array<string | undefined>
  return CLIENT_BY_ENTRYPOINT.get(entrypoint.toLowerCase()) ?? "claude-code"
}

export const CLAUDE_CLIENT_NAMES: Readonly<Record<ClaudeClient, string>> = {
  "claude-code": "Claude Code",
  "claude-desktop": "Claude Desktop",
  cowork: "Claude Desktop (Cowork)",
}
