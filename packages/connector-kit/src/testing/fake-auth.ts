import type {
  AuthStrategy,
  ConnectorAccount,
  TokenProvider,
} from "../auth/token-provider"

import { ConnectorError, signedOut } from "../errors"

export const ADA: ConnectorAccount = {
  username: "ada@contoso.com",
  name: "Ada Lovelace",
  tenantId: "00000000-0000-4000-8000-0000000000aa",
}

/** In-memory `TokenProvider`: no identity provider, controllable sign-in. */
export class FakeTokenProvider implements TokenProvider {
  token = "token-1"
  /** Account `signIn` completes as (unless `completeSignIn` names another). */
  defaultAccount: ConnectorAccount
  signedIn: ConnectorAccount | undefined
  /** When set, `getToken` fails with this (e.g. an expired refresh token). */
  tokenError: Error | undefined
  /** When true, `signIn` waits until `completeSignIn()` or abort. */
  manualSignIn = false
  /** When true, a rejected token can be "refreshed" (`invalidate` → `true`), switching to `refreshedToken` if set. */
  refreshable = false
  refreshedToken: string | undefined
  signInCalls = 0
  signOutCalls = 0
  tokenCalls = 0
  invalidateCalls = 0
  #pending:
    | {
        resolve(account: ConnectorAccount): void
        reject(error: unknown): void
      }
    | undefined

  constructor(
    signedIn?: ConnectorAccount,
    options: { account?: ConnectorAccount; token?: string } = {},
  ) {
    this.signedIn = signedIn
    this.defaultAccount = options.account ?? signedIn ?? ADA
    if (options.token) this.token = options.token
  }

  account(): Promise<ConnectorAccount | undefined> {
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

  async signIn(signal: AbortSignal): Promise<ConnectorAccount> {
    this.signInCalls++
    if (!this.manualSignIn) {
      this.signedIn = this.defaultAccount
      return this.defaultAccount
    }
    return await new Promise<ConnectorAccount>((resolve, reject) => {
      signal.addEventListener(
        "abort",
        () =>
          reject(
            new ConnectorError("sign-in-cancelled", "Sign-in was cancelled."),
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

  completeSignIn(account: ConnectorAccount = this.defaultAccount): void {
    this.#pending?.resolve(account)
    this.#pending = undefined
  }

  failSignIn(error: unknown): void {
    this.#pending?.reject(error)
    this.#pending = undefined
  }

  invalidate(): Promise<boolean> {
    this.invalidateCalls++
    if (!this.refreshable || !this.signedIn) return Promise.resolve(false)
    if (this.refreshedToken) this.token = this.refreshedToken
    return Promise.resolve(true)
  }

  signOut(): Promise<void> {
    this.signOutCalls++
    this.signedIn = undefined
    return Promise.resolve()
  }
}

export interface FakeAuthOptions {
  /** Who "signs in" (default Ada Lovelace at contoso.com). */
  account?: ConnectorAccount
  /** Bearer token handed upstream (default `token-1`, the fake server's default). */
  token?: string
  /** Start signed in (default `false`: the user clicks Sign in, which completes instantly). */
  signedIn?: boolean
}

/**
 * A sign-in strategy that signs in instantly as `account`, for tests and the
 * bench. Each plugin instance gets a fresh `FakeTokenProvider`; `providers`
 * lists them so tests can drive or inspect them.
 */
export function fakeAuth(
  options: FakeAuthOptions = {},
): AuthStrategy & { readonly providers: Array<FakeTokenProvider> } {
  const providers: Array<FakeTokenProvider> = []
  const account = options.account ?? ADA
  return {
    type: "fake",
    interactive: true,
    signInPrompt: `Sign in as ${account.username ?? "the test account"}`,
    providers,
    create() {
      const provider = new FakeTokenProvider(
        options.signedIn ? account : undefined,
        { account, ...(options.token ? { token: options.token } : {}) },
      )
      providers.push(provider)
      return provider
    },
  }
}
