import { randomUUID } from "node:crypto"

import type { ModelsResponse } from "~/services/copilot/get-models"

import { SingletonCache } from "./cache"

// Module-private metric mirrors of the matching `state.*` fields.
// Surfaced via allCacheMetrics() (registered on construction); writes
// flow through setCopilotToken / setModels below so callers can't
// forget the mirror.
const modelsCache = new SingletonCache<ModelsResponse>({ name: "models" })
const copilotTokenCache = new SingletonCache<string>({ name: "copilot_token" })

export interface State {
  githubToken?: string
  userName?: string
  copilotToken?: string

  accountType: string
  models?: ModelsResponse
  vsCodeVersion?: string

  macMachineId?: string
  vsCodeSessionId?: string
  vsCodeDeviceId: string

  manualApprove: boolean
  rateLimitWait: boolean
  showToken: boolean

  // Rate limiting configuration
  rateLimitSeconds?: number
  lastRequestTimestamp?: number
  verbose: boolean

  copilotApiUrl?: string
}

export const state: State = {
  accountType: "individual",
  manualApprove: false,
  rateLimitWait: false,
  showToken: false,
  verbose: false,
  vsCodeDeviceId: randomUUID(),
}

export function setCopilotToken(token: string): void {
  // Skip the metric refresh when the upstream returned the same token —
  // otherwise the refresh counter inflates with no-op rotations.
  if (state.copilotToken === token) return
  state.copilotToken = token
  copilotTokenCache.set(token)
}

export function setModels(models: ModelsResponse): void {
  state.models = models
  modelsCache.set(models)
}
