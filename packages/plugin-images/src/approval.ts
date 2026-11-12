/**
 * The approval the image tools wait for before their first billed call.
 *
 * The plugin SDK has no prompt a server tool can raise mid-call (MCP
 * elicitation belongs to client-run tools, and connector terms to
 * connectors), so this is the same shape the FigJam pairing request takes: the
 * first call is refused with a plain explanation for the model to pass on,
 * and the plugin asks the person where they will see it: a notification, the
 * menu-bar tray (`status.attention`) and the plugin's row in Settings. The
 * person's OK is recorded in the plugin's storage and holds from then on; the
 * Budget limits keep governing what is spent.
 */
import type {
  Context,
  PluginStatus,
  ToolResult,
} from "@stuffbucket/maximal-plugin-sdk"

import type { ToolGate } from "./tools"

export const APPROVAL_FILE = "approval.json"
export const APPROVE_ACTION = "allow-image-tools"

const APPROVE_LABEL = "Allow image tools"
const ASK_SUMMARY =
  "Claude Code wants to generate images. Each image is billed to your account."

const WAITING_TEXT =
  "Not run: image generation is billed to the user's account and they have not approved it yet. An approval request is waiting in Maximal (Settings > Plugins > Images, or the menu-bar tray). Tell the user, and don't try again until they say they have approved it."

export interface Approval {
  gate: ToolGate
  /** The status with the approval step added while it is outstanding. */
  decorate(status: PluginStatus): PluginStatus
  readonly granted: boolean
}

/**
 * `needed` is false when no tool is on: nothing to approve. `changed` runs
 * after the approval state changes, to publish the status again.
 */
export async function createApproval(
  ctx: Context,
  needed: boolean,
  changed: () => void,
): Promise<Approval> {
  let granted =
    !needed || (await ctx.storage.readText(APPROVAL_FILE)) !== undefined
  let asked = false

  if (!granted) {
    ctx.surface.registerAction(APPROVE_ACTION, async () => {
      await ctx.storage.writeText(
        APPROVAL_FILE,
        JSON.stringify({ approvedAt: new Date().toISOString() }),
      )
      granted = true
      changed()
    })
  }

  const gate: ToolGate = {
    check: () => {
      if (granted) return Promise.resolve(undefined)
      if (!asked) {
        asked = true
        ctx.surface.notify({
          code: "images-approval-requested",
          message: ASK_SUMMARY,
        })
        changed()
      }
      const refused: ToolResult = {
        isError: true,
        content: [{ type: "text", text: WAITING_TEXT }],
      }
      return Promise.resolve(refused)
    },
  }

  return {
    gate,
    get granted() {
      return granted
    },
    decorate(status) {
      if (granted) return status
      const actions = [
        {
          id: APPROVE_ACTION,
          label: APPROVE_LABEL,
          kind: "primary" as const,
          confirm:
            "Allow Claude Code to generate and edit images? Each image is billed to your account, within your Budget limits.",
        },
      ]
      return {
        ...status,
        actions: [...(status.actions ?? []), ...actions],
        ...(asked ? { attention: { summary: ASK_SUMMARY, actions } } : {}),
      }
    },
  }
}
