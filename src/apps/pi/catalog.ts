import { parseAccountType, toCopilotHost } from "~/lib/auth/auth-types"
import { readDefaultRecord } from "~/lib/auth/github-token-store"
import { cacheVSCodeVersion } from "~/lib/platform/utils"
import {
  setCopilotToken,
  setGithubToken,
  state,
} from "~/lib/runtime-state/state"
import { getModels } from "~/services/copilot/get-models"
import { getCopilotToken } from "~/services/github/get-copilot-token"

/** One-shot catalog read using Maximal's saved identity; never opens sign-in or starts a refresh daemon. */
export async function fetchPiCatalog(accountType = "individual") {
  state.accountType = parseAccountType(accountType)
  const record = await readDefaultRecord()
  if (!record) throw new Error("Sign in to Maximal before syncing Pi models")
  setGithubToken(record.accessToken)
  await cacheVSCodeVersion()
  if (record.tokenType === "gho_") {
    setCopilotToken(record.accessToken)
  } else {
    const minted = await getCopilotToken()
    if (minted.endpoints?.api) {
      const host = toCopilotHost(minted.endpoints.api)
      if (!host) throw new Error("Copilot returned an invalid catalog host")
      state.copilotApiUrl = host
    }
    setCopilotToken(minted.token)
  }
  return getModels()
}
