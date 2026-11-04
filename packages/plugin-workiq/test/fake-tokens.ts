import type { TokenProvider, WorkIqAccount } from "../src/auth/token-provider"

import { signedOut, WorkIqError } from "../src/errors"

export const ADA: WorkIqAccount = {
  username: "ada@contoso.com",
  name: "Ada Lovelace",
  tenantId: "00000000-0000-4000-8000-0000000000aa",
}

/** In-memory `TokenProvider`: no Entra, controllable sign-in. */
export class FakeTokenProvider implements TokenProvider {
  token = "token-1"
  signedIn: WorkIqAccount | undefined
  /** When set, `getToken` fails with this (e.g. an expired refresh token). */
  tokenError: Error | undefined
  /** When true, `signIn` waits until `completeSignIn()` or abort. */
  manualSignIn = false
  signInCalls = 0
  signOutCalls = 0
  tokenCalls = 0
  #pending:
    | { resolve(account: WorkIqAccount): void; reject(error: unknown): void }
    | undefined

  constructor(signedIn?: WorkIqAccount) {
    this.signedIn = signedIn
  }

  account(): Promise<WorkIqAccount | undefined> {
    return Promise.resolve(this.signedIn)
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async so synchronous throws (abort, signed out) surface as rejections like the real provider
  async getToken(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    this.tokenCalls++
    if (this.tokenError) throw this.tokenError
    if (!this.signedIn) throw signedOut()
    return this.token
  }

  async signIn(signal: AbortSignal): Promise<WorkIqAccount> {
    this.signInCalls++
    if (!this.manualSignIn) {
      this.signedIn = ADA
      return ADA
    }
    return await new Promise<WorkIqAccount>((resolve, reject) => {
      signal.addEventListener(
        "abort",
        () =>
          reject(
            new WorkIqError("sign-in-cancelled", "Sign-in was cancelled."),
          ),
        { once: true },
      )
      this.#pending = {
        resolve: (account) => {
          this.signedIn = account
          resolve(account)
        },
        reject,
      }
    })
  }

  get signInPending(): boolean {
    return this.#pending !== undefined
  }

  completeSignIn(account: WorkIqAccount = ADA): void {
    this.#pending?.resolve(account)
    this.#pending = undefined
  }

  failSignIn(error: unknown): void {
    this.#pending?.reject(error)
    this.#pending = undefined
  }

  signOut(): Promise<void> {
    this.signOutCalls++
    this.signedIn = undefined
    return Promise.resolve()
  }
}
