import type { ReactElement } from 'react'

// Signed-out screen: the entry point into the device flow. One primary
// heading, one primary action.

interface SignInScreenProps {
  busy: boolean
  onSignIn: () => void
}

export function SignInScreen({ busy, onSignIn }: SignInScreenProps): ReactElement {
  return (
    <div className="first-run-screen">
      <h1 className="first-run-heading">Sign in to Maximal</h1>
      <p className="first-run-note">
        Maximal uses your GitHub account to authorize access. You'll get a code to enter on
        GitHub's site — nothing to type here.
      </p>
      <button type="button" className="first-run-button first-run-button--primary" onClick={onSignIn} disabled={busy}>
        {busy ? 'Starting…' : 'Sign in with GitHub'}
      </button>
    </div>
  )
}
