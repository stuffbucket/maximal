import type { CommandDef } from "citty"

import type { ClientApp } from "./index"

import { claudeCodeApp } from "./claude-code"
import { claudeDesktopApp } from "./claude-desktop"
import { copilotCliApp } from "./copilot-cli"

const apps: Record<string, ClientApp> = {
  "claude-code": claudeCodeApp,
  "claude-desktop": claudeDesktopApp,
  "copilot-cli": copilotCliApp,
}

export function getAllApps(): Array<ClientApp> {
  return [apps["claude-code"], apps["claude-desktop"], apps["copilot-cli"]]
}

export function getApp(id: string): ClientApp | undefined {
  return apps[id]
}

/** The subcommand name (`configure-claude-code`) a command registers under.
 *  citty types `meta` as `Resolvable<CommandMeta>` (it may be a promise/thunk),
 *  but every app command we own passes a literal `{ name }`; read it defensively
 *  and fall back to the app id so the registry never throws on an exotic meta. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches citty's SubCommandsDef = Record<string, Resolvable<CommandDef<any>>>
function commandName(command: CommandDef<any>, fallback: string): string {
  const meta = command.meta
  if (meta && typeof meta === "object" && "name" in meta) {
    const name = (meta as { name?: unknown }).name
    if (typeof name === "string" && name.length > 0) return name
  }
  return fallback
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches citty's SubCommandsDef = Record<string, Resolvable<CommandDef<any>>>
export function getAppCliCommands(): Record<string, CommandDef<any>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
  const commands: Record<string, CommandDef<any>> = {}
  for (const app of getAllApps()) {
    if (app.cliCommand) {
      commands[commandName(app.cliCommand, app.id)] = app.cliCommand
    }
  }
  return commands
}
