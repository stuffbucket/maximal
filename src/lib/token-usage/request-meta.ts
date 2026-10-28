/** Where a request's context-window numbers came from. */
export type WindowSource =
  | "codex-catalog"
  | "claude-1m"
  | "models-endpoint"
  | "model-listing"

/** The context window a request ran under. `null` means unknown. */
export interface RequestContextWindow {
  windowTokens: number | null
  ceilingTokens: number | null
  compactAtTokens: number | null
  source: WindowSource
}
