/**
 * The broker's side of asking Maximal for user input over the control
 * channel: `elicit` out, `elicitResult` back with the same requestId, and
 * `elicitWithdrawn` when the request stops needing an answer.
 */

import type { ElicitResult } from "@modelcontextprotocol/client"

import { randomUUID } from "node:crypto"

import type { AskMaximal, MaximalElicitation } from "./elicitation.ts"

const CANCEL: ElicitResult = { action: "cancel" }

export type SendControl = (
  frame:
    | { operation: "elicit"; requestId: string; payload: MaximalElicitation }
    | {
        operation: "elicitWithdrawn"
        requestId: string
        payload: Record<string, never>
      },
) => Promise<void>

export class MaximalElicitations {
  readonly #send: SendControl
  readonly #pending = new Map<string, (result: ElicitResult) => void>()

  constructor(send: SendControl) {
    this.#send = send
  }

  readonly ask: AskMaximal = (request, signal) =>
    new Promise<ElicitResult>((resolve) => {
      const requestId = `elicit-${randomUUID()}`
      const settle = (result: ElicitResult) => {
        if (!this.#pending.delete(requestId)) return
        signal.removeEventListener("abort", onAbort)
        resolve(result)
      }
      const onAbort = () => {
        if (!this.#pending.has(requestId)) return
        settle(CANCEL)
        void this.#send({
          operation: "elicitWithdrawn",
          requestId,
          payload: {},
        }).catch(() => undefined)
      }

      this.#pending.set(requestId, settle)
      signal.addEventListener("abort", onAbort, { once: true })
      if (signal.aborted) {
        onAbort()
        return
      }
      this.#send({ operation: "elicit", requestId, payload: request }).catch(
        () => settle(CANCEL),
      )
    })

  /** Deliver Maximal's answer. One for a request no longer waiting (it was
   *  withdrawn while the answer was in flight) is ignored. */
  settle(requestId: string, result: ElicitResult): void {
    this.#pending.get(requestId)?.(result)
  }

  /** Cancel everything still waiting, e.g. when the broker stops. */
  cancelAll(): void {
    for (const settle of this.#pending.values()) settle(CANCEL)
  }

  get size(): number {
    return this.#pending.size
  }
}
