/** The signed-in Microsoft Entra account (work or school). */
export interface WorkIqAccount {
  /** UPN / email, e.g. `ada@contoso.com`. */
  username: string
  name?: string
  /** Entra tenant id (GUID). */
  tenantId?: string
}

/**
 * Everything the plugin needs from an identity provider. The MSAL
 * implementation lives in `./msal`; tests inject a fake.
 */
export interface TokenProvider {
  /** The cached account, if any (no network). */
  account(): Promise<WorkIqAccount | undefined>
  /**
   * A fresh access token for the Work IQ audience, acquired silently
   * (cache or refresh token). Rejects with a `signed-out` `WorkIqError` when
   * the user must sign in interactively.
   */
  getToken(signal?: AbortSignal): Promise<string>
  /** Interactive sign-in in the system browser. Rejects when `signal` aborts. */
  signIn(signal: AbortSignal): Promise<WorkIqAccount>
  /** Forget every account and delete the persisted token cache. */
  signOut(): Promise<void>
}

/** Text persistence the token cache needs (a subset of `ctx.storage`). */
export interface TextStore {
  readText(name: string): Promise<string | undefined>
  writeText(name: string, text: string): Promise<void>
  delete(name: string): Promise<void>
}
