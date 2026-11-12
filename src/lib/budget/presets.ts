/**
 * Suggestions for the Rules window: reset presets (when a rule's period
 * starts over) and persona presets (limit templates for common ways of using
 * Maximal). Pure. A preset is only a suggestion the UI turns into a draft
 * rule; nothing here is applied, and no figure claims to be any provider's
 * current plan.
 */

import type {
  BudgetPersonaPreset,
  BudgetPresetLimit,
  BudgetPresetsResponse,
  BudgetResetPreset,
} from "~/lib/config/settings-types"

import { providerWindowRef, type ProviderQuotaWindow } from "./provider-windows"
import { displayToNanoAiu, type BudgetDisplay } from "./units"
import { formatAmount } from "./wording"

export interface PresetInputs {
  display: BudgetDisplay
  /** The windows providers have reported; each can be followed. */
  windows: ReadonlyArray<Pick<ProviderQuotaWindow, "provider" | "id" | "label">>
  /** The labels of the client keys that exist, for per-key presets. */
  keyLabels: ReadonlyArray<string>
}

const FIXED_RESETS: ReadonlyArray<BudgetResetPreset> = [
  {
    id: "daily",
    label: "Daily",
    description: "Starts over at 00:00 UTC every day.",
    limit_reset: "daily",
    window: null,
  },
  {
    id: "weekly",
    label: "Weekly",
    description: "Starts over at 00:00 UTC every Monday.",
    limit_reset: "weekly",
    window: null,
  },
  {
    id: "monthly-1",
    label: "Monthly on the 1st",
    description: "Starts over at 00:00 UTC on the 1st of each month.",
    limit_reset: { monthly: { day: 1 } },
    window: null,
  },
  {
    id: "every-5h",
    label: "Every 5 hours (rolling)",
    description:
      "Counts spend from the last 5 hours, like the rolling 5-hour plan windows some providers use. Room comes back as old spend ages out.",
    limit_reset: { every: { hours: 5 } },
    window: null,
  },
  {
    id: "every-24h",
    label: "Every 24 hours (rolling)",
    description:
      "Counts spend from the last 24 hours. Room comes back as old spend ages out.",
    limit_reset: { every: { hours: 24 } },
    window: null,
  },
  {
    id: "every-7d",
    label: "Every 7 days (rolling)",
    description:
      "Counts spend from the last 7 days. Room comes back as old spend ages out.",
    limit_reset: { every: { days: 7 } },
    window: null,
  },
  {
    id: "never",
    label: "Never",
    description: "A lifetime cap that never starts over.",
    limit_reset: "never",
    window: null,
  },
]

export function resetPresets(
  windows: PresetInputs["windows"],
): Array<BudgetResetPreset> {
  return [
    ...FIXED_RESETS,
    ...windows.map((window): BudgetResetPreset => {
      const ref = providerWindowRef(window)
      return {
        id: `follow:${ref}`,
        label: `Follow ${window.label}`,
        description: `Starts over when the provider resets: ${window.label}.`,
        limit_reset: { follow: ref },
        window: ref,
      }
    }),
  ]
}

/** A rule id from a client key's label (`My laptop` becomes `my-laptop`). */
export function slugOf(text: string): string {
  const slug = text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 40)
    .replaceAll(/-+$/gu, "")
  return slug === "" ? "key" : slug
}

type TemplateFields = Pick<
  BudgetPresetLimit,
  "id" | "label" | "scope" | "limit_reset" | "warn_at" | "action"
> & {
  /** US dollars, whatever unit the person reads. */
  usd: number
}

function template(
  { display }: PresetInputs,
  { usd, ...fields }: TemplateFields,
): BudgetPresetLimit {
  const limit = displayToNanoAiu(usd, {
    unit: "usd",
    creditUsd: display.creditUsd,
  })
  return {
    ...fields,
    limit,
    amount: display.unit === "usd" ? usd : usd / display.creditUsd,
  }
}

/** One daily cap per key label, or one that asks which key. */
function teamLimits(
  inputs: PresetInputs,
  labels: ReadonlyArray<string>,
): Array<BudgetPresetLimit> {
  if (labels.length === 0) {
    return [
      template(inputs, {
        id: "team-key-daily",
        label: "Daily cap for each key",
        scope: { kind: "key", id: null },
        limit_reset: "daily",
        warn_at: 0.8,
        action: "block",
        usd: 20,
      }),
    ]
  }
  return labels.map((label) =>
    template(inputs, {
      id: `${slugOf(label)}-daily`,
      label: `Daily cap for ${label}`,
      scope: { kind: "key", id: label },
      limit_reset: "daily",
      warn_at: 0.8,
      action: "block",
      usd: 20,
    }),
  )
}

export function personaPresets(
  inputs: PresetInputs,
): Array<BudgetPersonaPreset> {
  const { display } = inputs
  const money = (usd: number): string =>
    formatAmount(
      displayToNanoAiu(usd, { unit: "usd", creditUsd: display.creditUsd }),
      display,
    )
  const global = { kind: "global" } as const
  const labels = [...new Set(inputs.keyLabels)]
  return [
    {
      id: "trying-things-out",
      label: `Trying things out: ${money(5)}/day`,
      description: "A small daily cap while you find out what things cost.",
      limits: [
        template(inputs, {
          id: "daily-cap",
          label: "Daily cap",
          scope: global,
          limit_reset: "daily",
          warn_at: 0.8,
          action: "block",
          usd: 5,
        }),
      ],
    },
    {
      id: "daily-driver",
      label: `Daily driver: ${money(20)}/day plus ${money(100)}/week`,
      description:
        "A daily cap for steady use, and a weekly one so a few heavy days can't add up.",
      limits: [
        template(inputs, {
          id: "daily-cap",
          label: "Daily cap",
          scope: global,
          limit_reset: "daily",
          warn_at: 0.8,
          action: "block",
          usd: 20,
        }),
        template(inputs, {
          id: "weekly-cap",
          label: "Weekly cap",
          scope: global,
          limit_reset: "weekly",
          warn_at: 0.8,
          action: "block",
          usd: 100,
        }),
      ],
    },
    {
      id: "heavy-agent-use",
      label: `Heavy agent use: ${money(50)} per rolling 5 hours, warn at 80%`,
      description:
        "Room for long agent sessions, paced like rolling plan windows: the last 5 hours of spend count, and room returns as it ages out.",
      limits: [
        template(inputs, {
          id: "rolling-5h-cap",
          label: "Rolling 5-hour cap",
          scope: global,
          limit_reset: { every: { hours: 5 } },
          warn_at: 0.8,
          action: "block",
          usd: 50,
        }),
      ],
    },
    {
      id: "team",
      label: `Team: per-key caps of ${money(20)}/day`,
      description:
        labels.length === 0 ?
          "One daily cap per client key. Pick the key each cap applies to."
        : "One daily cap for each of your client keys.",
      limits: teamLimits(inputs, labels),
    },
  ]
}

export function buildBudgetPresets(
  inputs: PresetInputs,
): BudgetPresetsResponse {
  return {
    display: {
      unit: inputs.display.unit,
      credit_usd: inputs.display.creditUsd,
    },
    resets: resetPresets(inputs.windows),
    personas: personaPresets(inputs),
  }
}
