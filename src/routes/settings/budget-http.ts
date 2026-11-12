/**
 * Replies the budget routes share: the status snapshot, a change that also
 * tells the shell, and a 400.
 */

import type { Context } from "hono"

import { currentBudgetStatus, emitBudgetChanged } from "~/lib/budget/runtime"
import { BudgetStatusResponse } from "~/lib/config/settings-types"

import { respondValidated } from "./respond-validated"

export async function respondStatus(c: Context): Promise<Response> {
  return respondValidated(
    c,
    { schema: BudgetStatusResponse, label: "Budget" },
    await currentBudgetStatus(),
  )
}

/** The reply to a change, which also tells the shell. */
export async function respondChanged(c: Context): Promise<Response> {
  const response = await respondStatus(c)
  emitBudgetChanged()
  return response
}

export function validationError(
  c: Context,
  message: string,
  details?: unknown,
): Response {
  return c.json(
    {
      error: {
        message,
        type: "validation_error",
        ...(details === undefined ? {} : { details }),
      },
    },
    400,
  )
}

/** `{ error: { message, type, ...extra } }` with a status. */
export function errorBody(
  c: Context,
  status: 400 | 404 | 409 | 429 | 502,
  error: { type: string; message: string } & Record<string, unknown>,
): Response {
  return c.json({ error }, status)
}
