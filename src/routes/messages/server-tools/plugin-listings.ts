/**
 * Plugin-provided server tools, read through the plugin gateway.
 */

import type {
  PluginGateway,
  PluginGenerationLease,
  ServerToolSpend,
  ServerToolView,
  ToolResult,
} from "@stuffbucket/maximal-plugin-sdk/gateway"

import { randomUUID } from "node:crypto"

import type { BudgetRefusal } from "~/lib/budget/errors"
import type {
  BudgetHold,
  BudgetService,
  ObservedBudgetTokens,
} from "~/lib/budget/service"
import type { AnthropicToolUseBlock } from "~/lib/models/anthropic-types"

import { BudgetExceededError } from "~/lib/budget/errors"
import { estimateOperationNanoAiu } from "~/lib/budget/estimate"
import {
  currentBudgetKey,
  reserveBudget,
  settleBudgetUsage,
  unreconcileBudgetUsage,
} from "~/lib/budget/runtime"
import { providerInvocationJournal } from "~/lib/plugins/provider-broker"
import { prepareOperationUsage } from "~/routes/passthrough"

import type { ServerToolListing, ServerToolRun } from "./types"

/** What a tool with no text output says to the model (the API rejects an
 *  empty `tool_result`). */
const NO_OUTPUT = "(no output)"

/** A tool's result as the text the model reads. Text blocks joined; a tool
 *  that only returned `structuredContent` gets it as JSON. */
function resultText(result: ToolResult): string {
  const text = result.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
  if (text !== "") return text
  if (result.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent)
  }
  return NO_OUTPUT
}

function runFrom(toolUseId: string, result: ToolResult): ServerToolRun {
  const isError = result.isError === true
  return {
    toolResult: {
      type: "tool_result",
      tool_use_id: toolUseId,
      content: resultText(result),
      ...(isError ? { is_error: true } : {}),
    },
    ok: !isError,
    ...(isError ? { code: "tool_error" } : {}),
  }
}

function failureText(error: unknown): string {
  return error instanceof Error && error.message !== "" ?
      error.message
    : "The tool is not available."
}

/** Only `hidden` has a client rendering for plugin tools so far. */
const SERVED_RENDERS: ReadonlySet<string> = new Set(["hidden"])

/** What the model reads when a limit refuses the call: the reason in plain
 *  words, so it can tell the person, and (unless it is only moments) not to
 *  retry. The tool's description never changes, so the prompt cache holds. */
function refusalResult(refusal: BudgetRefusal): ToolResult {
  const retry =
    refusal.inFlight ? "" : (
      " Don't retry this tool until the rule resets or is raised."
    )
  return {
    isError: true,
    content: [{ type: "text", text: `Not run: ${refusal.message}${retry}` }],
    structuredContent: {
      budget: {
        limit_id: refusal.limitId,
        resets_at:
          refusal.resetsAtMs === null ?
            null
          : new Date(refusal.resetsAtMs).toISOString(),
      },
    },
  }
}

type ReleaseReason = Parameters<BudgetHold["release"]>[0]

interface InvocationAccounting {
  readonly reportSpend: (spend: ServerToolSpend) => void
  readonly close: (failed: boolean, reason: ReleaseReason) => Promise<void>
}

class InvocationAccountingState implements InvocationAccounting {
  readonly #events: Array<
    NonNullable<ReturnType<typeof prepareOperationUsage>>
  > = []
  readonly #observedTokens: ObservedBudgetTokens = {
    input: false,
    output: false,
  }
  readonly #reported = new Map<string, number>()
  readonly #held: BudgetHold
  readonly #invocationId: string
  readonly #pluginId: string
  #lastSequence = 0
  #billedNanoAiu = 0
  #observed = false
  #completeBill = true

  constructor(held: BudgetHold, invocationId: string, pluginId: string) {
    this.#held = held
    this.#invocationId = invocationId
    this.#pluginId = pluginId
  }

  reportSpend = (spend: ServerToolSpend): void => {
    if (spend.invocationId !== this.#invocationId)
      throw new Error("Server-tool spend used the wrong invocation id.")
    const previous = this.#reported.get(spend.providerCallId)
    if (previous !== undefined) {
      if (previous !== spend.sequence)
        throw new Error("Server-tool provider-call id was reused.")
      return
    }
    if (spend.sequence <= this.#lastSequence)
      throw new Error("Server-tool spend sequence must increase.")
    const observation = providerInvocationJournal
      .unacknowledged(this.#invocationId)
      .find(
        (candidate) =>
          candidate.invocation.providerCallId === spend.providerCallId,
      )
    if (
      !observation
      || observation.outcome !== "success"
      || observation.invocation.sequence !== spend.sequence
      || observation.invocation.operation !== spend.operation
      || observation.provider !== spend.provider
    )
      throw new Error("Server-tool spend did not match a provider call.")
    this.#lastSequence = spend.sequence
    this.#reported.set(spend.providerCallId, spend.sequence)
    this.#record({
      ...spend,
      result:
        observation.cost === undefined ?
          spend.result
        : { ...spend.result, cost: observation.cost },
    })
  }

  close = async (failed: boolean, reason: ReleaseReason): Promise<void> => {
    this.#collectUnreported()
    if (this.#observed && this.#completeBill) {
      await settleBudgetUsage(this.#held, this.#events, this.#billedNanoAiu)
    } else if (!failed || this.#observed || this.#held.persisted) {
      await unreconcileBudgetUsage(this.#held, this.#events, {
        reason: "usage-missing",
        observedTokens: this.#observedTokens,
      })
    } else {
      await this.#held.release(reason)
    }
    for (const [providerCallId, sequence] of this.#reported) {
      providerInvocationJournal.acknowledge(
        this.#invocationId,
        providerCallId,
        sequence,
      )
    }
    providerInvocationJournal.finish(this.#invocationId)
  }

  #collectUnreported(): void {
    // A call observed by the parent was billed even if the runner died before
    // reporting it. Pending calls keep the hold unreconciled; they are never
    // replayed because their provider outcome is ambiguous.
    for (const observation of providerInvocationJournal.unacknowledged(
      this.#invocationId,
    )) {
      const { invocation } = observation
      if (this.#reported.has(invocation.providerCallId)) continue
      this.#reported.set(invocation.providerCallId, invocation.sequence)
      if (observation.outcome !== "success") {
        this.#completeBill = false
        continue
      }
      this.#record({
        operation: invocation.operation,
        model: invocation.model,
        provider: observation.provider,
        result: {
          usage: {},
          ...(observation.cost === undefined ? {} : { cost: observation.cost }),
        },
      })
    }
  }

  #record(
    spend: Pick<ServerToolSpend, "operation" | "model" | "provider" | "result">,
  ): void {
    this.#observed = true
    const event = prepareOperationUsage(
      {
        operation: spend.operation,
        model: spend.model,
        provider: spend.provider,
        pluginId: this.#pluginId,
      },
      spend.result,
    )
    if (event) this.#events.push(event)
    this.#observedTokens.input ||=
      typeof spend.result.usage.input_tokens === "number"
      || typeof spend.result.usage.cache_read_input_tokens === "number"
    this.#observedTokens.output ||=
      typeof spend.result.usage.output_tokens === "number"
    if (spend.result.cost?.amount === undefined) this.#completeBill = false
    else this.#billedNanoAiu += spend.result.cost.amount
  }
}

function invocationAccounting(
  held: BudgetHold,
  invocationId: string,
  pluginId: string,
): InvocationAccounting {
  return new InvocationAccountingState(held, invocationId, pluginId)
}

// eslint-disable-next-line max-params -- keeps generation, view, budget, and lifecycle explicit
function listingFor(
  generation: PluginGenerationLease,
  view: ServerToolView,
  budget: BudgetService | undefined,
  release: () => void,
): ServerToolListing {
  return {
    owner: view.pluginId,
    name: view.name,
    description: view.description,
    input_schema: view.input_schema,
    render: view.render,
    offer: view.offer,
    clients: view.clients,
    release,
    run: async (toolUse: AnthropicToolUseBlock, call) => {
      // Preparation runs inside the generation lease captured when this tool
      // was offered, so estimate, admission, execution and accounting cannot
      // cross a cutover.
      let prepared
      try {
        prepared = await generation.prepareServerTool(
          view.pluginId,
          view.name,
          toolUse.input,
        )
      } catch (error) {
        return runFrom(toolUse.id, {
          isError: true,
          content: [{ type: "text", text: failureText(error) }],
        })
      }
      const { estimate } = prepared
      let hold
      try {
        hold = await reserveBudget(
          {
            operation: "server_tool",
            plugin: view.pluginId,
            tool: view.name,
            key: currentBudgetKey(),
            ...(estimate?.provider === undefined ?
              {}
            : { provider: estimate.provider }),
            estimateNanoAiu:
              estimate ?
                estimateOperationNanoAiu(estimate.operation, estimate.body)
              : 0,
          },
          budget,
        )
      } catch (error) {
        prepared.release()
        // A refusal is the tool's result, never an error of the turn.
        if (error instanceof BudgetExceededError) {
          return runFrom(toolUse.id, refusalResult(error.refusal))
        }
        return runFrom(toolUse.id, {
          isError: true,
          content: [{ type: "text", text: failureText(error) }],
        })
      }
      // What the tool reports it spent is persisted with the hold before the
      // terminal result is returned. Parent-observed provider calls cover a
      // runner loss between the billable response and this callback.
      const invocationId = randomUUID()
      let providerSequence = 0
      const accounting = invocationAccounting(hold, invocationId, view.pluginId)
      try {
        let result: ToolResult
        try {
          result = await prepared.execute({
            ...call,
            invocationId,
            nextProviderCall: (operation, model) => ({
              invocationId,
              providerCallId: randomUUID(),
              sequence: ++providerSequence,
              operation,
              model,
            }),
            reportSpend: accounting.reportSpend,
          })
        } catch (error) {
          await accounting.close(
            true,
            call.signal.aborted ? "aborted" : "upstream-error",
          )
          // The plugin stopped between the plan and the call. The model gets
          // the failure and carries on without the tool.
          return runFrom(toolUse.id, {
            isError: true,
            content: [{ type: "text", text: failureText(error) }],
          })
        }
        await accounting.close(result.isError === true, "upstream-error")
        return runFrom(toolUse.id, result)
      } finally {
        prepared.release()
      }
    },
  }
}

/**
 * The server tools the running plugins offer right now. Cheap: reads the
 * gateway's live registry, so call it per request.
 *
 * `onUnserved` hears of a tool whose render the loop cannot show the client
 * for a plugin tool (everything but `hidden`); it is not offered. `budget`
 * defaults to the app's budget service.
 */
export function pluginServerToolListings(
  gateway: PluginGateway | undefined,
  onUnserved: (view: ServerToolView) => void = () => {},
  budget?: BudgetService,
): Array<ServerToolListing> {
  if (!gateway) return []
  const generation = gateway.acquireGeneration()
  const views = generation.serverTools()
  if (views.length === 0) {
    generation.release()
    return []
  }
  let remaining = views.length
  const releaseOne = (): void => {
    remaining -= 1
    if (remaining === 0) generation.release()
  }
  const listings: Array<ServerToolListing> = []
  for (const view of views) {
    let released = false
    // One release closure is intentionally created for each offered view.
    // eslint-disable-next-line unicorn/consistent-function-scoping
    const release = () => {
      if (released) return
      released = true
      releaseOne()
    }
    if (!SERVED_RENDERS.has(view.render)) {
      onUnserved(view)
      release()
      continue
    }
    listings.push(listingFor(generation, view, budget, release))
  }
  return listings
}
