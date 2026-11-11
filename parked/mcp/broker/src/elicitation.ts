/**
 * Answers an upstream server's request for user input (MCP elicitation): a
 * form to fill in, or a URL to open.
 *
 * Each request goes to whoever the endpoint's policy names. `passthrough`
 * asks the session's own client when that client said it can show this kind
 * of request, and otherwise Maximal. `maximal` always asks Maximal, which
 * shows it in Settings. `deny` declines without asking. A request nobody
 * answers within the policy's timeout is cancelled.
 *
 * Server text is untrusted. Forms asking for credentials or payment details
 * (which MCP forbids) are declined, as are requests too large or too
 * complex for Maximal to show.
 */

import type {
  ElicitRequestFormParams,
  ElicitRequestParams,
  ElicitRequestURLParams,
  ElicitResult,
} from "@modelcontextprotocol/client"
import type { Server } from "@modelcontextprotocol/server"

import type {
  ElicitationAction,
  ElicitationFieldType,
  ElicitationMechanism,
  ElicitationPolicy,
} from "./wire-config.ts"

/** Largest message Maximal shows. */
export const MAX_MESSAGE_LENGTH = 4096
/** Most fields a form Maximal shows may have. */
export const MAX_FORM_PROPERTIES = 32

const DECLINE: ElicitResult = { action: "decline" }
const CANCEL: ElicitResult = { action: "cancel" }

const SENSITIVE_FIELD =
  /pass(?:word|code|phrase)|secret|token|api[\s_-]?key|credit|card|cvv|cvc|iban|ssn|social[\s_-]?security/iu

type FormSchema = ElicitRequestFormParams["requestedSchema"]

/** A request as Maximal shows it, sent to the sidecar. */
export interface MaximalElicitation {
  endpointId: string
  label: string
  toolName?: string
  mechanism: ElicitationMechanism
  mode: "form" | "url"
  message: string
  requestedSchema?: FormSchema
  url?: string
  expiresAtMs: number
}

/** Ask Maximal to put a request in front of the user. Resolves with the
 *  answer; `signal` aborts when the request should be withdrawn. */
export type AskMaximal = (
  request: MaximalElicitation,
  signal: AbortSignal,
) => Promise<ElicitResult>

export interface ElicitationContext {
  endpointId: string
  label: string
  era: "legacy" | "modern"
  policy: ElicitationPolicy
  /** The tool call this request belongs to, when exactly one is running. */
  toolName?: string
  /** The session's client-facing server, used for passthrough. */
  downstream?: Server
  askMaximal?: AskMaximal
  /** Aborts when the upstream cancels the request or the session closes. */
  signal: AbortSignal
  now?: () => number
}

/** Field kinds Maximal can show; anything else is "unsupported". */
type FieldKind = ElicitationFieldType | "unsupported"

export interface ElicitationClassification {
  mode: "form" | "url"
  mechanism: ElicitationMechanism
  fieldTypes: Array<FieldKind>
  propertyCount: number
  urlHost?: string
}

const isUrlRequest = (
  params: ElicitRequestParams,
): params is ElicitRequestURLParams => params.mode === "url"

const fieldKind = (property: Record<string, unknown>): FieldKind => {
  switch (property.type) {
    case "boolean":
    case "number":
    case "integer": {
      return property.type
    }
    case "string": {
      return "enum" in property || "oneOf" in property ? "enum" : "string"
    }
    default: {
      return "unsupported"
    }
  }
}

export const classifyElicitation = (
  params: ElicitRequestParams,
  era: "legacy" | "modern",
): ElicitationClassification => {
  if (isUrlRequest(params)) {
    let urlHost: string | undefined
    try {
      urlHost = new URL(params.url).hostname.toLowerCase()
    } catch {
      urlHost = undefined
    }
    return {
      mode: "url",
      mechanism: era === "modern" ? "modern-input-required" : "legacy-url",
      fieldTypes: [],
      propertyCount: 0,
      urlHost,
    }
  }
  const properties = Object.values(params.requestedSchema.properties) as Array<
    Record<string, unknown>
  >
  return {
    mode: "form",
    mechanism: era === "modern" ? "modern-input-required" : "legacy-form",
    fieldTypes: [...new Set(properties.map((property) => fieldKind(property)))],
    propertyCount: properties.length,
  }
}

const ruleMatches = (
  match: ElicitationPolicy["rules"][number]["match"],
  request: ElicitationClassification,
  toolName: string | undefined,
): boolean =>
  (match.toolNames === undefined
    || (toolName !== undefined && match.toolNames.includes(toolName)))
  && (match.mechanisms === undefined
    || match.mechanisms.includes(request.mechanism))
  && (match.modes === undefined || match.modes.includes(request.mode))
  && (match.fieldTypes === undefined
    || (request.mode === "form"
      && request.fieldTypes.every((kind) =>
        (match.fieldTypes as Array<FieldKind>).includes(kind),
      )))
  && (match.urlHosts === undefined
    || (request.urlHost !== undefined
      && match.urlHosts.some((host) => host.toLowerCase() === request.urlHost)))
  && (match.maxProperties === undefined
    || request.propertyCount <= match.maxProperties)

/** The first matching rule's action, else the policy's default. */
export const chooseElicitationAction = (
  policy: ElicitationPolicy,
  request: ElicitationClassification,
  toolName?: string,
): ElicitationAction =>
  policy.rules.find((rule) => ruleMatches(rule.match, request, toolName))
    ?.action ?? policy.defaultAction

/** Whether a policy can ever ask anyone; if not, don't advertise support. */
export const policyCanElicit = (policy: ElicitationPolicy): boolean =>
  policy.defaultAction !== "deny"
  || policy.rules.some((rule) => rule.action !== "deny")

/** A form asking for something MCP forbids servers to ask for in a form. */
export const asksForSensitiveData = (params: ElicitRequestParams): boolean => {
  if (isUrlRequest(params)) return false
  return Object.entries(params.requestedSchema.properties).some(
    ([name, property]) =>
      SENSITIVE_FIELD.test(name)
      || (typeof property.title === "string"
        && SENSITIVE_FIELD.test(property.title)),
  )
}

const clientCanShow = (
  downstream: Server | undefined,
  mode: "form" | "url",
): boolean => {
  const elicitation = downstream?.getClientCapabilities()?.elicitation
  if (elicitation === undefined) return false
  if (mode === "url") return elicitation.url !== undefined
  // An empty `elicitation: {}` predates modes and means forms.
  return elicitation.form !== undefined || elicitation.url === undefined
}

const maximalCanShow = (
  params: ElicitRequestParams,
  request: ElicitationClassification,
): boolean =>
  params.message.length <= MAX_MESSAGE_LENGTH
  && request.propertyCount <= MAX_FORM_PROPERTIES
  && !request.fieldTypes.includes("unsupported")

/** What the client is asked: the request without the server's metadata. */
const forClient = (params: ElicitRequestParams): ElicitRequestParams =>
  isUrlRequest(params) ?
    {
      mode: "url",
      message: params.message,
      url: params.url,
      elicitationId: params.elicitationId,
    }
  : { message: params.message, requestedSchema: params.requestedSchema }

export const answerElicitation = async (
  params: ElicitRequestParams,
  context: ElicitationContext,
): Promise<ElicitResult> => {
  if (asksForSensitiveData(params)) return DECLINE

  const request = classifyElicitation(params, context.era)
  const action = chooseElicitationAction(
    context.policy,
    request,
    context.toolName,
  )
  if (action === "deny") return DECLINE

  const now = context.now ?? Date.now
  const timeoutMs = context.policy.timeoutMs
  const expiresAtMs = now() + timeoutMs
  const signal = AbortSignal.any([
    context.signal,
    AbortSignal.timeout(timeoutMs),
  ])

  if (
    action === "passthrough"
    && context.downstream
    && clientCanShow(context.downstream, request.mode)
  ) {
    try {
      return await context.downstream.elicitInput(forClient(params), {
        signal,
        timeout: timeoutMs,
      })
    } catch {
      if (signal.aborted) return CANCEL
      // The client couldn't take it after all; Maximal can.
    }
  }

  if (!context.askMaximal || !maximalCanShow(params, request)) return DECLINE
  if (signal.aborted) return CANCEL
  try {
    return await context.askMaximal(
      {
        endpointId: context.endpointId,
        label: context.label,
        ...(context.toolName === undefined ?
          {}
        : { toolName: context.toolName }),
        mechanism: request.mechanism,
        mode: request.mode,
        message: params.message,
        ...(isUrlRequest(params) ?
          { url: params.url }
        : { requestedSchema: params.requestedSchema }),
        expiresAtMs,
      },
      signal,
    )
  } catch {
    return CANCEL
  }
}
