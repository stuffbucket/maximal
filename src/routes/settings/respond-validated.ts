/**
 * Shared "validate then respond" envelope for `/settings/api/*` routes.
 *
 * Every settings endpoint schema-validates its payload against the
 * published contract before responding, so drift between the runtime
 * shape and the contract fails loudly in tests rather than silently in
 * the UI. The success/failure envelope was copy-pasted across apps.ts,
 * api.ts and models.ts (audit B10); this collapses it to one place.
 *
 * On success: `c.json(parsed.data)` (200). On failure: a 500 with the
 * standard `{ error: { message, type: "internal_error", details } }`
 * body, where `message` is `${label} payload failed schema validation`
 * — matching the previous per-route strings verbatim.
 */

import type { Context } from "hono"
import type { z } from "zod"

export interface ValidatedResponseSpec<T extends z.ZodType> {
  schema: T
  /** Prefix for the failure message: `${label} payload failed schema
   *  validation`. Kept per-route to match the prior string literals. */
  label: string
}

export function respondValidated<T extends z.ZodType>(
  c: Context,
  spec: ValidatedResponseSpec<T>,
  payload: z.input<T>,
): Response {
  const parsed = spec.schema.safeParse(payload)
  if (!parsed.success) {
    return c.json(
      {
        error: {
          message: `${spec.label} payload failed schema validation`,
          type: "internal_error",
          details: parsed.error.issues,
        },
      },
      500,
    )
  }
  return c.json(parsed.data)
}
