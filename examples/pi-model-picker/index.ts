import {
  type ExtensionAPI,
  type ExtensionContext,
  ModelSelectorComponent,
} from "@earendil-works/pi-coding-agent"
import { mixColors, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"

import { installPickerRenderer } from "./renderer.ts"

type Theme = ExtensionContext["ui"]["theme"]

/** Selection background tinted toward the accent: many themes (and translucent
 * terminals) make a plain selectedBg nearly invisible on the base background. */
function highlight(theme: Theme, text: string): string {
  try {
    const bg = mixColors(theme.colors.selectedBg, theme.colors.accent, 0.3)
    return theme.style(text, { bg })
  } catch {
    return theme.bg("selectedBg", text)
  }
}

/** Shared by terminal and desktop hosts; no requests, credentials or model mutations. */
export default function modelPicker(pi: ExtensionAPI) {
  let restore: (() => void) | undefined
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return
    restore?.()
    try {
      // Read the theme at render time so /theme changes apply without a reload.
      restore = installPickerRenderer(ModelSelectorComponent.prototype, {
        fg: (token, text) => ctx.ui.theme.fg(token, text),
        selected: (text) => highlight(ctx.ui.theme, text),
        bold: (text) => ctx.ui.theme.bold(text),
        truncate: (text, width) => truncateToWidth(text, width, "…"),
        measure: visibleWidth,
      })
    } catch (error) {
      ctx.ui.notify(
        `Model-price display unavailable; native picker retained: ${String(error)}`,
        "warning",
      )
    }
  })
  pi.on("session_shutdown", () => {
    restore?.()
    restore = undefined
  })
}
