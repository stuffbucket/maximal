/**
 * Mock-free test utilities shared by the auth-controller / auth-flow tests.
 *
 * These deliberately contain NO mock.module setup. Bun's mock.module is
 * process-global, so a shared module that applied mocks would leak its stubs
 * into sibling test files; the auth-controller mock harness therefore stays
 * inline in each test file (the codebase convention). Only these pure helpers
 * — a deferred promise, a microtask flush, and a consola spy — live here.
 */

import consolaDefault from "consola"

const consola = consolaDefault

export type Deferred<T> = {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
}

/** A promise with externally-callable resolve/reject — for driving an
 *  in-flight poll/mint to completion at a precise point in a test. */
export function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Wait for a fire-and-forget poller's microtask chain to settle. */
export async function flushMicrotasks(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve()
  }
}

/** Spy on consola.warn / consola.error, capturing call args. Returns the
 *  captured calls and a restore() to put the original method back. */
export function spyConsola(method: "warn" | "error"): {
  calls: Array<Array<unknown>>
  restore: () => void
} {
  const calls: Array<Array<unknown>> = []
  const original = consola[method].bind(consola)
  consola[method] = ((...args: Array<unknown>) => {
    calls.push(args)
  }) as typeof consola.warn
  return {
    calls,
    restore: () => {
      consola[method] = original
    },
  }
}
