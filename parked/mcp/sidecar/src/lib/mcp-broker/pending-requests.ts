/**
 * Requests for user input from MCP servers that are waiting for an answer
 * in Maximal (Settings → Requests).
 *
 * The broker sends one when a server asks for input that the session's own
 * client can't show (or the server's policy says Maximal should). Each is
 * answered at most once: the first answer is sent back to the broker, and
 * any later one finds it gone.
 *
 * Kept in memory only. A request belongs to a live session inside the
 * broker, which is a child of this process, so none can outlive a restart;
 * storing them would only show requests nobody can answer.
 *
 * Everything in a request came from the MCP server and is untrusted: forms
 * are normalized to a small set of field kinds here, and answers are
 * checked against that before they reach the server.
 */

import type {
  PendingRequest,
  PendingRequestAnswer,
  PendingRequestField,
  PendingRequestsResponse,
  PendingRequestsSummary,
} from "~/lib/config/settings-types"
import type {
  ElicitPayload,
  ElicitResultPayload,
} from "~/lib/mcp-broker/control-protocol"

import { settingsEventBus } from "~/lib/config/settings-events"

/** How long an answered request's id is remembered, to tell "answered
 *  already" from "never existed". */
const ANSWERED_MEMORY_MS = 10 * 60_000

type Answer = (result: ElicitResultPayload) => void

interface Entry {
  generation: string
  request: PendingRequest
  answer: Answer
}

export type AnswerOutcome =
  | { ok: true }
  | { ok: false; reason: "not-found" | "answered" }
  | { ok: false; reason: "invalid"; problems: Array<string> }

const text = (value: unknown, max = 1024): string | undefined =>
  typeof value === "string" ? value.slice(0, max) : undefined

const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

const FORMATS = new Set(["email", "uri", "date", "date-time"])

/** One property of a server's form schema as a field Maximal can show, or
 *  undefined when it isn't one (the broker declines those first). */
function toField(
  name: string,
  property: Record<string, unknown>,
  required: boolean,
): PendingRequestField | undefined {
  const base = {
    name,
    title: text(property.title, 256),
    description: text(property.description),
    required,
  }
  switch (property.type) {
    case "boolean": {
      return {
        ...base,
        kind: "boolean",
        default:
          typeof property.default === "boolean" ? property.default : undefined,
      }
    }
    case "number":
    case "integer": {
      return {
        ...base,
        kind: property.type,
        minimum: finite(property.minimum),
        maximum: finite(property.maximum),
        default: finite(property.default),
      }
    }
    case "string": {
      const options = enumOptions(property)
      if (options) {
        return {
          ...base,
          kind: "enum",
          options,
          default: text(property.default, 256),
        }
      }
      const format = text(property.format)
      return {
        ...base,
        kind: "string",
        minLength: finite(property.minLength),
        maxLength: finite(property.maxLength),
        format:
          format && FORMATS.has(format) ?
            (format as PendingRequestField["format"])
          : undefined,
        default: text(property.default),
      }
    }
    default: {
      return undefined
    }
  }
}

function enumOptions(
  property: Record<string, unknown>,
): Array<{ value: string; label: string }> | undefined {
  if (Array.isArray(property.enum)) {
    const names = Array.isArray(property.enumNames) ? property.enumNames : []
    return property.enum
      .filter((value): value is string => typeof value === "string")
      .map((value, index) => ({
        value,
        label: text(names[index], 256) ?? value,
      }))
  }
  if (Array.isArray(property.oneOf)) {
    return property.oneOf.flatMap((option: unknown) => {
      if (typeof option !== "object" || option === null) return []
      const { const: value, title } = option as Record<string, unknown>
      return typeof value === "string" ?
          [{ value, label: text(title, 256) ?? value }]
        : []
    })
  }
  return undefined
}

function toFields(
  schema: ElicitPayload["requestedSchema"],
): Array<PendingRequestField> | undefined {
  if (!schema) return []
  const required = new Set(schema.required ?? [])
  const fields: Array<PendingRequestField> = []
  for (const [name, property] of Object.entries(schema.properties)) {
    const field = toField(name, property, required.has(name))
    if (!field) return undefined
    fields.push(field)
  }
  return fields
}

const hostOf = (url: string | undefined): string | undefined => {
  if (!url) return undefined
  try {
    return new URL(url).hostname
  } catch {
    return undefined
  }
}

const EMAIL = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/u
const DATE = /^\d{4}-\d{2}-\d{2}$/u

function formatProblem(
  field: PendingRequestField,
  value: string,
): string | undefined {
  switch (field.format) {
    case "email": {
      return EMAIL.test(value) ? undefined : "must be an email address"
    }
    case "uri": {
      try {
        new URL(value)
        return undefined
      } catch {
        return "must be a URL"
      }
    }
    case "date": {
      return DATE.test(value) && !Number.isNaN(Date.parse(value)) ?
          undefined
        : "must be a date (YYYY-MM-DD)"
    }
    case "date-time": {
      return Number.isNaN(Date.parse(value)) ?
          "must be a date and time"
        : undefined
    }
    default: {
      return undefined
    }
  }
}

function numberProblem(
  field: PendingRequestField,
  value: string | number | boolean,
): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "must be a number"
  }
  if (field.kind === "integer" && !Number.isInteger(value)) {
    return "must be a whole number"
  }
  if (field.minimum !== undefined && value < field.minimum) {
    return `must be at least ${field.minimum}`
  }
  if (field.maximum !== undefined && value > field.maximum) {
    return `must be at most ${field.maximum}`
  }
  return undefined
}

function stringProblem(
  field: PendingRequestField,
  value: string | number | boolean,
): string | undefined {
  if (typeof value !== "string") return "must be text"
  if (field.minLength !== undefined && value.length < field.minLength) {
    return `must be at least ${field.minLength} characters`
  }
  if (field.maxLength !== undefined && value.length > field.maxLength) {
    return `must be at most ${field.maxLength} characters`
  }
  return formatProblem(field, value)
}

function fieldProblem(
  field: PendingRequestField,
  value: string | number | boolean,
): string | undefined {
  switch (field.kind) {
    case "boolean": {
      return typeof value === "boolean" ? undefined : "must be true or false"
    }
    case "enum": {
      const allowed = (field.options ?? []).some(
        (option) => option.value === value,
      )
      return allowed ? undefined : "must be one of the choices"
    }
    case "string": {
      return stringProblem(field, value)
    }
    default: {
      return numberProblem(field, value)
    }
  }
}

/** Problems with an answer to `request`, one per offending field; empty
 *  when it can be sent. */
export function answerProblems(
  request: PendingRequest,
  answer: PendingRequestAnswer,
): Array<string> {
  if (answer.action !== "accept" || request.mode === "url") {
    return answer.content === undefined ?
        []
      : ["content is only sent when accepting a form"]
  }
  const content = answer.content ?? {}
  const fields = new Map(request.fields.map((field) => [field.name, field]))
  const problems: Array<string> = []
  for (const name of Object.keys(content)) {
    if (!fields.has(name)) problems.push(`${name}: not a field of this form`)
  }
  for (const field of request.fields) {
    if (!Object.hasOwn(content, field.name)) {
      if (field.required) problems.push(`${field.name}: required`)
      continue
    }
    const problem = fieldProblem(field, content[field.name])
    if (problem) problems.push(`${field.name}: ${problem}`)
  }
  return problems
}

export class PendingRequests {
  readonly #entries = new Map<string, Entry>()
  readonly #answered = new Map<string, number>()
  readonly #now: () => number
  readonly #onChange: () => void

  constructor(options: { now?: () => number; onChange?: () => void } = {}) {
    this.#now = options.now ?? Date.now
    this.#onChange = options.onChange ?? (() => undefined)
  }

  /**
   * Take a request from the broker. Returns false when Maximal can't show
   * it (a form field it doesn't know); the caller then declines it.
   */
  add({
    generation,
    requestId,
    payload,
    answer,
  }: {
    generation: string
    requestId: string
    payload: ElicitPayload
    answer: Answer
  }): boolean {
    const fields = toFields(payload.requestedSchema)
    if (fields === undefined) return false
    this.#entries.set(requestId, {
      generation,
      answer,
      request: {
        id: requestId,
        endpointId: payload.endpointId,
        label: payload.label,
        ...(payload.toolName === undefined ?
          {}
        : { toolName: payload.toolName }),
        mode: payload.mode,
        message: payload.message,
        fields,
        ...(payload.url === undefined ?
          {}
        : { url: payload.url, urlHost: hostOf(payload.url) }),
        receivedAt: new Date(this.#now()).toISOString(),
        expiresAt: new Date(payload.expiresAtMs).toISOString(),
      },
    })
    this.#onChange()
    return true
  }

  /** The broker no longer needs an answer (timed out, cancelled, closed). */
  withdraw(requestId: string): void {
    if (this.#entries.delete(requestId)) this.#onChange()
  }

  /** Drop everything a broker generation asked; it's gone. */
  dropGeneration(generation: string): void {
    let changed = false
    for (const [id, entry] of this.#entries) {
      if (entry.generation === generation) {
        this.#entries.delete(id)
        changed = true
      }
    }
    if (changed) this.#onChange()
  }

  list(): PendingRequestsResponse {
    this.#forgetExpired()
    return {
      requests: [...this.#entries.values()]
        .map((entry) => entry.request)
        .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt)),
    }
  }

  summary(): PendingRequestsSummary {
    const { requests } = this.list()
    return {
      pending: requests.length,
      newestId: requests.at(-1)?.id ?? null,
    }
  }

  /** Answer a request; only the first answer counts. */
  answer(id: string, answer: PendingRequestAnswer): AnswerOutcome {
    this.#forgetExpired()
    const entry = this.#entries.get(id)
    if (!entry) {
      return {
        ok: false,
        reason: this.#answered.has(id) ? "answered" : "not-found",
      }
    }
    const problems = answerProblems(entry.request, answer)
    if (problems.length > 0) return { ok: false, reason: "invalid", problems }

    this.#entries.delete(id)
    this.#answered.set(id, this.#now())
    entry.answer({
      action: answer.action,
      ...(answer.content === undefined ? {} : { content: answer.content }),
    })
    this.#onChange()
    return { ok: true }
  }

  #forgetExpired(): void {
    const now = this.#now()
    let changed = false
    for (const [id, entry] of this.#entries) {
      // The broker withdraws a request when it expires; this covers a
      // withdrawal that never arrived.
      if (Date.parse(entry.request.expiresAt) < now) {
        this.#entries.delete(id)
        changed = true
      }
    }
    for (const [id, at] of this.#answered) {
      if (now - at > ANSWERED_MEMORY_MS) this.#answered.delete(id)
    }
    if (changed) this.#onChange()
  }
}

/** The process-wide store the supervisor fills and Settings reads. */
export const pendingRequests = new PendingRequests({
  onChange: () => {
    settingsEventBus.publish("requests.changed", pendingRequests.list())
  },
})
