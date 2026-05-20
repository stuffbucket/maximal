/**
 * /settings/api/api-keys — CRUD for the API-key registry that gates
 * the proxy's `x-api-key` / `Authorization: Bearer` middleware.
 *
 * Wire shape lives in `src/lib/settings-types.ts`. Persistence is via
 * `writeConfig()` in `src/lib/config.ts`, which writes atomically and
 * invalidates the in-memory cache so the next `getConfiguredApiKeys()`
 * (which the auth middleware calls per request) sees the change
 * immediately — no proxy restart required.
 *
 * Security notes:
 * - These routes are auth-gated by the parent middleware (see
 *   `server.ts` — `/settings/api` is NOT in `allowUnauthenticatedPaths`
 *   or `allowUnauthenticatedPrefixes`). So an attacker who can't
 *   already auth cannot enumerate keys.
 * - Returned bodies include the *full* key value. This is deliberate:
 *   show/hide lives in the UI, and there's no value in obscuring a
 *   secret over a channel the same caller already authenticated to.
 * - Key charset is restricted by `API_KEY_VALUE_PATTERN` so a hand-
 *   typed key can't carry shell-special characters into a user's
 *   CLI invocation.
 */

import { Hono } from "hono"
import { randomBytes, randomUUID } from "node:crypto"

import { getConfig, writeConfig } from "~/lib/config"
import { API_KEY_VALUE_PATTERN } from "~/lib/config-schema"
import {
  ApiKeyCreateRequest,
  ApiKeysListResponse,
  ApiKeyUpdateRequest,
  type ApiKeyEntry,
} from "~/lib/settings-types"

export const apiKeysRoutes = new Hono()

/**
 * Generate a random 32-character key. base64url-ish but restricted to
 * the same charset the validator accepts. Prefixed `mxl_` so an
 * accidental commit is greppable.
 */
function generateKey(): string {
  // 24 bytes → 32 base64url chars (`=` stripped). base64url uses only
  // [A-Za-z0-9_-], so the result already matches API_KEY_VALUE_PATTERN
  // (minus the prefix, which we add separately and is also in-charset).
  const body = randomBytes(24).toString("base64url")
  return `mxl_${body}`
}

function buildListResponse(): ApiKeysListResponse {
  const config = getConfig()
  const entries = config.auth?.apiKeyEntries ?? []
  const enforcing = config.auth?.enforce === true
  return { entries, enforcing }
}

apiKeysRoutes.get("/", (c) => {
  return c.json(buildListResponse())
})

apiKeysRoutes.post("/", async (c) => {
  const body: unknown = await c.req.json().catch(() => null)
  const parsed = ApiKeyCreateRequest.safeParse(body)
  if (!parsed.success) {
    return c.json(
      {
        error: { message: "Invalid create payload", type: "validation_error" },
      },
      400,
    )
  }
  const key = (parsed.data.key ?? generateKey()).trim()
  if (!API_KEY_VALUE_PATTERN.test(key)) {
    return c.json(
      {
        error: {
          message:
            "Key must be 8–128 chars of letters, digits, underscore, or hyphen — or the literal '*' wildcard.",
          type: "validation_error",
        },
      },
      400,
    )
  }

  const config = getConfig()
  const existing = config.auth?.apiKeyEntries ?? []
  if (existing.some((e) => e.key === key)) {
    return c.json(
      { error: { message: "Key already exists", type: "conflict" } },
      409,
    )
  }

  const entry: ApiKeyEntry = {
    id: randomUUID(),
    label: parsed.data.label.trim(),
    key,
    enabled: parsed.data.enabled ?? true,
    created_at: new Date().toISOString(),
  }

  writeConfig({
    ...config,
    auth: {
      ...config.auth,
      apiKeyEntries: [...existing, entry],
    },
  })

  return c.json(entry, 201)
})

apiKeysRoutes.patch("/enforce", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    enforce?: unknown
  } | null
  if (!body || typeof body.enforce !== "boolean") {
    return c.json(
      {
        error: {
          message: "Expected { enforce: boolean }",
          type: "validation_error",
        },
      },
      400,
    )
  }
  const config = getConfig()
  writeConfig({
    ...config,
    auth: { ...config.auth, enforce: body.enforce },
  })
  return c.json(buildListResponse())
})

apiKeysRoutes.patch("/:id", async (c) => {
  const id = c.req.param("id")
  const body: unknown = await c.req.json().catch(() => null)
  const parsed = ApiKeyUpdateRequest.safeParse(body)
  if (!parsed.success) {
    return c.json(
      {
        error: { message: "Invalid update payload", type: "validation_error" },
      },
      400,
    )
  }

  const config = getConfig()
  const entries = config.auth?.apiKeyEntries ?? []
  const idx = entries.findIndex((e) => e.id === id)
  if (idx === -1) {
    return c.json(
      { error: { message: "API key not found", type: "not_found" } },
      404,
    )
  }
  const current = entries[idx]

  let nextKey = current.key
  if (parsed.data.key !== undefined) {
    const candidate = parsed.data.key.trim()
    if (!API_KEY_VALUE_PATTERN.test(candidate)) {
      return c.json(
        {
          error: {
            message:
              "Key must be 8–128 chars of letters, digits, underscore, or hyphen — or the literal '*' wildcard.",
            type: "validation_error",
          },
        },
        400,
      )
    }
    // Reject duplicates (other than self).
    if (entries.some((e, i) => i !== idx && e.key === candidate)) {
      return c.json(
        { error: { message: "Key already exists", type: "conflict" } },
        409,
      )
    }
    nextKey = candidate
  }

  const updated: ApiKeyEntry = {
    ...current,
    label: parsed.data.label?.trim() ?? current.label,
    key: nextKey,
    enabled: parsed.data.enabled ?? current.enabled,
  }

  const nextEntries = [...entries]
  nextEntries[idx] = updated

  writeConfig({
    ...config,
    auth: { ...config.auth, apiKeyEntries: nextEntries },
  })

  return c.json(updated)
})

apiKeysRoutes.delete("/:id", (c) => {
  const id = c.req.param("id")
  const config = getConfig()
  const entries = config.auth?.apiKeyEntries ?? []
  const next = entries.filter((e) => e.id !== id)
  if (next.length === entries.length) {
    return c.json(
      { error: { message: "API key not found", type: "not_found" } },
      404,
    )
  }
  writeConfig({
    ...config,
    auth: { ...config.auth, apiKeyEntries: next },
  })
  return c.body(null, 204)
})
