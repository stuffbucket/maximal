/**
 * Narrowing helpers for AuthStatus tests (ADR-0006). AuthStatus is a
 * discriminated union on `state`; tests that previously read optional
 * fields directly off the union now narrow with these one-line asserts.
 *
 * Each helper:
 *  1. asserts the union member matches via `expect()` (so a mismatch
 *     produces a normal Bun test failure with a useful message), and
 *  2. is typed as a `asserts` predicate so TS narrows the original
 *     local at the call site — no extra `as` casts needed.
 */
import { expect } from "bun:test"

import type { AuthStatus } from "~/lib/config/settings-types"

export type PendingStatus = Extract<
  AuthStatus,
  { state: "device_code_issued" | "polling" }
>
export type AuthenticatedStatus = Extract<
  AuthStatus,
  { state: "authenticated" }
>
export type ErrorStatus = Extract<AuthStatus, { state: "error" }>

export function assertPending(s: AuthStatus): asserts s is PendingStatus {
  expect(["device_code_issued", "polling"]).toContain(s.state)
}

export function assertAuthenticated(
  s: AuthStatus,
): asserts s is AuthenticatedStatus {
  expect(s.state).toBe("authenticated")
}

export function assertError(s: AuthStatus): asserts s is ErrorStatus {
  expect(s.state).toBe("error")
}
