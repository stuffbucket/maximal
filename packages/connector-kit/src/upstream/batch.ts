import type { ToolResult } from "@stuffbucket/maximal-plugin-sdk"

import type { ResultThrottle } from "./classify"

import { seconds, type ConnectorError } from "../errors"
import { resultBody } from "./classify"

/** Whether a merged entry failed: its own `statusCode`, else its result's `isError`. */
function entryFailed(entry: unknown, source: ToolResult | undefined): boolean {
  const status = (entry as { statusCode?: unknown } | null)?.statusCode
  return typeof status === "number" ? status >= 400 : source?.isError === true
}

/** The throttle to wait for when several chunks were throttled: the longest hint, 429 first. */
function strongest(
  current: ResultThrottle | undefined,
  next: ResultThrottle,
): ResultThrottle {
  if (!current) return next
  const hints = [current.retryAfterMs, next.retryAfterMs].filter(
    (hint): hint is number => hint !== undefined,
  )
  return {
    status: current.status === 429 || next.status === 429 ? 429 : next.status,
    ...(hints.length > 0 ? { retryAfterMs: Math.max(...hints) } : {}),
  }
}

/**
 * The answers of one batch read across chunks and re-issue rounds: one
 * entry per item, in the caller's order, each from the latest answer that
 * covered it.
 */
export class BatchState {
  readonly #key: string
  readonly #entries: Array<unknown>
  readonly #sources: Array<ToolResult | undefined>
  #first: ToolResult | undefined
  #calls = 0
  /** Items throttled in the current round. */
  throttled: Array<number> = []
  /** The strongest throttle of the current round. */
  signal: ResultThrottle | undefined
  /** Why the batch stopped re-issuing, if it gave up. */
  gaveUp: ConnectorError | undefined

  constructor(total: number, key: string) {
    this.#key = key
    this.#entries = Array.from({ length: total })
    this.#sources = Array.from({ length: total })
  }

  get calls(): number {
    return this.#calls
  }

  /** Start a re-issue round. */
  round(): void {
    this.throttled = []
    this.signal = undefined
  }

  /** Whether every item of `chunk` has an answer from an earlier round. */
  answered(chunk: ReadonlyArray<number>): boolean {
    return chunk.every((index) => this.#sources[index] !== undefined)
  }

  /**
   * Record one chunk's answer; `false` when it does not hold one entry per
   * item (the caller decides what that means).
   */
  record(
    chunk: ReadonlyArray<number>,
    answer: { result: ToolResult; partial?: ResultThrottle },
  ): boolean {
    this.#calls++
    const list = resultBody(answer.result)?.[this.#key]
    if (!Array.isArray(list) || list.length !== chunk.length) return false
    this.#first ??= answer.result
    const marked = new Set(answer.partial?.indexes ?? [])
    for (const [position, index] of chunk.entries()) {
      this.#entries[index] = list[position]
      this.#sources[index] = answer.result
      if (marked.has(position)) this.throttled.push(index)
    }
    if (answer.partial && marked.size > 0)
      this.signal = strongest(this.signal, answer.partial)
    return true
  }

  /**
   * The merged result: the first answer untouched when it was the only
   * one, else one JSON text (and structured content when the service sent
   * it) with every entry in order, plus a note when some stay throttled.
   */
  result(name: string): ToolResult | undefined {
    const first = this.#first
    if (!first) return undefined
    if (this.#calls === 1 && this.throttled.length === 0) return first
    const entries = this.#entries
    const merged = { ...resultBody(first), [this.#key]: entries }
    const failed = entries.some((entry, index) =>
      entryFailed(entry, this.#sources[index]),
    )
    const retryAfterMs = this.gaveUp?.busy?.retryAfterMs
    const when =
      retryAfterMs === undefined ? "later" : (
        `in about ${seconds(retryAfterMs)} s`
      )
    const note =
      this.throttled.length === 0 ?
        undefined
      : `${this.throttled.length} of ${entries.length} entries were throttled by ${name} and still show the throttled status; retry those ${when}.`
    return {
      content: [
        { type: "text", text: JSON.stringify(merged) },
        ...(note ? [{ type: "text" as const, text: note }] : []),
      ],
      ...(first.structuredContent ? { structuredContent: merged } : {}),
      ...(failed ? { isError: true } : {}),
    }
  }
}
