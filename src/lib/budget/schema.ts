/**
 * Budget limits: the zod shapes shared by `config.json` (the `budget` block in
 * `~/lib/config/config-schema`) and the `/settings/api/budget` wire contracts
 * (`~/lib/config/settings-types`). The shell imports the wire contracts by
 * relative path, so this file imports nothing but zod.
 *
 * A limit is a plain spend cap: a scope, an amount in nano-AIU, when its
 * period resets, a warning threshold, and whether reaching it blocks or only
 * warns.
 */

import { z } from "zod"

/** A limit's stable, user-visible slug (`images-daily`). */
export const BudgetLimitId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u)

/** What a limit applies to. `global` matches every billed request; `key`
 *  matches one client key (the API key's label, or for a request with no
 *  key the client Maximal recognised, else `unidentified`); `plugin` a
 *  plugin or built-in capability (`images`); `provider` everything one
 *  provider bills (`copilot`). */
export const BudgetScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }),
  z.object({
    kind: z.enum(["key", "plugin", "provider"]),
    id: z.string().trim().min(1).max(128),
  }),
])
export type BudgetScope = z.infer<typeof BudgetScope>
export type BudgetScopeKind = BudgetScope["kind"]

/** `<provider>:<window id>`, e.g. `copilot:premium_interactions`. */
export const ProviderWindowRef = z
  .string()
  .max(160)
  .regex(/^[\w.-]+:[\w.-]+$/u)

/** When a limit's period resets: with a provider's quota window, or at
 *  00:00 UTC every day / every Monday, or never. */
export const BudgetLimitReset = z.union([
  z.enum(["daily", "weekly", "never"]),
  z.object({ follow: ProviderWindowRef }),
])
export type BudgetLimitReset = z.infer<typeof BudgetLimitReset>

export const BudgetLimitAction = z.enum(["block", "warn"])
export type BudgetLimitAction = z.infer<typeof BudgetLimitAction>

/** Fraction of the limit (0–1) at which the limit reads as a warning. */
export const BudgetWarnAt = z.number().min(0).max(1)
export const DEFAULT_WARN_AT = 0.8

/** Integer nano-AIU (10⁻⁹ AI credit), the unit every amount is stored in. */
export const NanoAiuAmount = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)

export const BudgetDisplayUnit = z.enum(["usd", "credits"])
export type BudgetDisplayUnit = z.infer<typeof BudgetDisplayUnit>

/** USD per AI credit. GitHub documents $0.01; this is the escape hatch if
 *  that changes. */
export const CreditUsdRate = z.number().positive().max(1000)

const BudgetLimitConfigSchema = z
  .object({
    id: BudgetLimitId,
    label: z.string().trim().min(1).max(128).optional(),
    scope: BudgetScope,
    limit: NanoAiuAmount,
    limitReset: BudgetLimitReset,
    warnAt: BudgetWarnAt.optional(),
    action: BudgetLimitAction,
  })
  .loose()

export const BudgetConfigSchema = z
  .object({
    /** False turns enforcement off (limits are kept and still reported);
     *  absent means on. */
    enabled: z.boolean().optional(),
    display: z
      .object({
        unit: BudgetDisplayUnit.optional(),
        creditUsd: CreditUsdRate.optional(),
      })
      .loose()
      .optional(),
    limits: z.array(BudgetLimitConfigSchema).max(256).optional(),
  })
  .loose()
  .superRefine((budget, ctx) => {
    const seen = new Set<string>()
    for (const [index, limit] of (budget.limits ?? []).entries()) {
      if (seen.has(limit.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate budget limit id '${limit.id}'`,
          path: ["limits", index, "id"],
        })
      }
      seen.add(limit.id)
    }
  })

export type BudgetLimitConfig = z.infer<typeof BudgetLimitConfigSchema>
export type BudgetConfig = z.infer<typeof BudgetConfigSchema>
