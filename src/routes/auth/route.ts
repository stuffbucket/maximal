/**
 * Device-code OAuth HTTP surface for the Tauri shell's setup window.
 *
 * Two endpoints, both unauthenticated (registered in
 * `server.ts` allowUnauthenticatedPrefixes). The proxy may be running
 * pre-setup with no API key configured, so requiring auth here would
 * deadlock the first-run flow.
 *
 * Contract: see docs/first-run-setup-prd.md, "HTTP contract" section.
 *
 *   POST /auth/start  → kicks off GitHub device-code, writes user_code
 *                       to the OS clipboard, returns the device-code
 *                       envelope. 409 if a token is already on disk.
 *   GET  /auth/poll   → one upstream poll per request. Pending/ready/
 *                       expired/error. The client controls cadence.
 *
 * State is a single module-level session inside `device-auth.ts`.
 * One concurrent setup at a time — acceptable for a desktop-app
 * first-run; a second /auth/start replaces the prior session.
 */

import { Hono } from "hono"

import {
  clearDeviceAuthSession,
  deviceCodeRemainingSeconds,
  getCurrentDeviceAuthSession,
  pollOnce,
  startDeviceAuth,
} from "~/lib/device-auth"
import { HTTPError } from "~/lib/error"
import {
  makeRecord,
  readDefaultRecord,
  writeDefaultRecord,
} from "~/lib/github-token-store"
import { state } from "~/lib/state"

export const authRoute = new Hono()

authRoute.post("/start", async (c) => {
  // "Already authenticated" — the PRD says 409 if a token validates.
  // We treat file-present + non-empty as the bar here; a live
  // introspection would force every shell launch through a network
  // round-trip even when nothing's wrong.
  const existing = await readDefaultRecord()
  if (existing && existing.accessToken) {
    return c.json({ error: "already_authenticated" }, 409)
  }

  try {
    const session = await startDeviceAuth()
    return c.json({
      verification_uri: session.verificationUri,
      verification_uri_complete: session.verificationUriComplete,
      user_code: session.userCode,
      expires_in: session.expiresIn,
      interval: session.interval,
      device_code: session.deviceCode,
    })
  } catch (err) {
    if (err instanceof HTTPError) {
      return c.json({ error: `github upstream ${err.response.status}` }, 502)
    }
    return c.json({ error: (err as Error).message }, 500)
  }
})

authRoute.get("/poll", async (c) => {
  const session = getCurrentDeviceAuthSession()
  if (!session) {
    return c.json({ error: "no_pending_auth" }, 404)
  }

  if (deviceCodeRemainingSeconds(session) <= 0) {
    clearDeviceAuthSession()
    return c.json({ status: "expired" })
  }

  const outcome = await pollOnce(session)

  switch (outcome.status) {
    case "pending":
    case "slow_down": {
      return c.json({ status: "pending", expires_in: outcome.expiresIn })
    }
    case "expired": {
      clearDeviceAuthSession()
      return c.json({ status: "expired" })
    }
    case "error": {
      // Terminal errors clear the session so the client knows to
      // re-call /auth/start. Transient ones (network blips) the
      // client can retry against the same session — but we don't
      // distinguish here. Lean toward clearing on access_denied only;
      // network errors leave the session in place.
      if (outcome.reason === "access_denied") {
        clearDeviceAuthSession()
      }
      return c.json({ status: "error", reason: outcome.reason })
    }
    case "ready": {
      // Persist the token to the same place the CLI writes it; this
      // is what `evaluateSetup` reads on the next /setup-status call.
      await writeDefaultRecord(makeRecord(outcome.accessToken))
      state.githubToken = outcome.accessToken
      clearDeviceAuthSession()

      let username = ""
      try {
        const { getGitHubUser } = await import("~/services/github/get-user")
        const user = await getGitHubUser(outcome.accessToken)
        username = user.login
        state.userName = user.login
      } catch {
        // /user can fail for transient reasons; the token is still
        // good and the next /setup-status will reflect ready: true.
        // Return ready with an empty username rather than masking the
        // success as an error.
      }
      return c.json({ status: "ready", username })
    }
    default: {
      // Exhaustiveness — DeviceAuthPollOutcome covers every case above.
      const _exhaustive: never = outcome
      void _exhaustive
      return c.json({ status: "error", reason: "unreachable" }, 500)
    }
  }
})
