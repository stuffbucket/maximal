// Shared handling for `AuthStatus`'s `account_login` best-effort-failure
// sentinel. `@stuffbucket/maximal-core/settings-types` documents that the
// `authenticated` variant's `account_login` is the literal string
// `"unknown"` when sign-in succeeded but the controller couldn't fetch the
// GitHub user (rather than the field being dropped), and that "the renderer
// treats `\"unknown\"` as a placeholder trigger" — i.e. this is a rendering
// obligation the wire contract assumes callers honour, not an edge case a
// surface can skip.

const UNKNOWN_ACCOUNT_LOGIN = 'unknown'

/** Maps the `"unknown"` sentinel to user-facing copy that doesn't read as a
 *  real (if oddly-named) GitHub handle. Any other value passes through
 *  unchanged. */
export function displayAccountLogin(login: string): string {
  return login === UNKNOWN_ACCOUNT_LOGIN ? 'your GitHub account' : login
}
