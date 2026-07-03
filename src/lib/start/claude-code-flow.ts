/**
 * Interactive --claude-code helper: prompt for primary + small model,
 * generate a clipboard-ready env script for launching Claude Code with
 * maximal as its ANTHROPIC_BASE_URL, and copy it.
 *
 * Note: this is a one-shot convenience for users who haven't enabled the
 * Apps panel toggle yet. The settings.json approach (writing
 * env.ANTHROPIC_BASE_URL into ~/.claude/settings.json — see
 * src/lib/claude-code-settings.ts and ADR/PR #74) is the recommended
 * persistent path; this flag remains for users who want a one-time
 * shell-snippet without touching their Claude settings file.
 */

import clipboard from "clipboardy"
import consola from "consola"
import invariant from "tiny-invariant"

import { generateEnvScript } from "~/lib/shell"
import { resolveSmallToolModel } from "~/lib/small-model"
import { state } from "~/lib/state"

export async function runClaudeCodeFlow(serverUrl: string): Promise<void> {
  consola.log(
    "\n💡 Tip: The --claude-code flag simply generates a clipboard command for launching Claude Code. \n"
      + "All models remain fully accessible without this flag, just configure the model ID directly in your settings.json file.",
  )

  invariant(state.models, "Models should be loaded by now")

  const modelIds = state.models.data.map((m) => m.id)

  const selectedModel = await consola.prompt(
    "Select a model to use with Claude Code",
    { type: "select", options: modelIds },
  )

  // The haiku tier carries Claude Code's background + subagent work, which
  // makes tool calls — so it must default to a tool-competent model, not a
  // cheap-but-weak one. Honor a pre-set ANTHROPIC_DEFAULT_HAIKU_MODEL if the
  // user already exported one; otherwise pre-select a resolved default.
  const recommendedSmallModel = resolveSmallToolModel(
    state.models.data,
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
  )

  const selectedSmallModel = await consola.prompt(
    "Select a small model to use with Claude Code (used for subagent + background"
      + " tool calls — pick a tool-capable model)",
    {
      type: "select",
      options: modelIds,
      // Pre-select a tool-competent haiku-class default when available, so the
      // user doesn't have to know that a weak small model breaks subagent tools.
      initial:
        recommendedSmallModel && modelIds.includes(recommendedSmallModel) ?
          recommendedSmallModel
        : undefined,
    },
  )

  const command = generateEnvScript(
    {
      ANTHROPIC_BASE_URL: serverUrl,
      ANTHROPIC_AUTH_TOKEN: "dummy",
      ANTHROPIC_MODEL: selectedModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: selectedModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: selectedSmallModel,
      DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
      CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "false",
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "true",
      CLAUDE_CODE_ENABLE_AWAY_SUMMARY: "0",
      CLAUDE_PLUGIN_ENABLE_QUESTION_RULES: "true",
    },
    "claude",
  )

  try {
    clipboard.writeSync(command)
    consola.success("Copied Claude Code command to clipboard!")
  } catch {
    consola.warn(
      "Failed to copy to clipboard. Here is the Claude Code command:",
    )
    consola.log(command)
  }
}
