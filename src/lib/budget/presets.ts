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
    id: "every-10m",
    label: "Every 10 minutes (rolling)",
    description:
      "Counts the last 10 minutes, for catching a burst: a runaway loop or a large fan-out of agents. Room comes back as it ages out.",
    limit_reset: { every: { minutes: 10 } },
    window: null,
  },
  {
    id: "every-1h",
    label: "Every hour (rolling)",
    description: "Counts the last hour. Room comes back as old usage ages out.",
    limit_reset: { every: { hours: 1 } },
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

type TemplateFields = Omit<BudgetPresetLimit, "amount" | "limit">
  & (
    | {
        /** US dollars, whatever unit the person reads. */
        usd: number
        tokens?: undefined
      }
    | {
        /** A count of tokens (the rule's `unit` is `tokens`). */
        tokens: number
        usd?: undefined
      }
  )

function template(
  { display }: PresetInputs,
  { usd, tokens, ...fields }: TemplateFields,
): BudgetPresetLimit {
  if (tokens !== undefined) {
    return { ...fields, unit: "tokens", limit: tokens, amount: tokens }
  }
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

/** Personas for catching a runaway: by tokens, while away, or in a burst. */
function guardPersonas(
  inputs: PresetInputs,
  money: (usd: number) => string,
): Array<BudgetPersonaPreset> {
  const global = { kind: "global" } as const
  return [
    {
      id: "runaway-guard",
      label: "Runaway guard: 2M tokens per rolling hour",
      description:
        "Counts tokens, not money, over the last hour: a loop that burns through a model's context again and again stops long before a dollar cap would notice.",
      limits: [
        template(inputs, {
          id: "runaway-tokens",
          label: "Runaway guard",
          scope: global,
          limit_reset: { every: { hours: 1 } },
          warn_at: 0.8,
          action: "block",
          tokens: 2_000_000,
        }),
      ],
    },
    {
      id: "while-away",
      label: `While you're away: ${money(10)} per rolling hour`,
      description:
        "Enforced only while the screen is locked or after 30 minutes with no keyboard or mouse input, to catch a process that keeps spending after you leave. It does nothing while you're at the machine, or when Maximal can't tell.",
      limits: [
        template(inputs, {
          id: "away-hourly",
          label: "While away",
          scope: global,
          limit_reset: { every: { hours: 1 } },
          warn_at: 0.8,
          action: "block",
          when: { locked: true, idleMinutes: 30 },
          usd: 10,
        }),
      ],
    },
    {
      id: "fan-out-guard",
      label: "Fan-out guard: 500k tokens and 120 requests per 10 minutes",
      description:
        "A short rolling window with a request cap beside the token cap, for a lead agent that spawns many subagents at once.",
      limits: [
        template(inputs, {
          id: "fan-out",
          label: "Fan-out guard",
          scope: global,
          limit_reset: { every: { minutes: 10 } },
          warn_at: 0.8,
          action: "block",
          max_requests: 120,
          tokens: 500_000,
        }),
      ],
    },
  ]
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
    ...guardPersonas(inputs, money),
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
