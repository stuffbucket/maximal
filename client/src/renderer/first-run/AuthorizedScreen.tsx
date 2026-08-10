import type { ReactElement } from 'react'

import { displayAccountLogin } from '../shared/account-login'

// Authorized screen: brief confirmation that sign-in succeeded. First-run
// is meant to hand off to the real app once this state is reached (that
// handoff is outside this task's scope — the mounting caller decides when
// to stop rendering `FirstRun` — but this screen is a valid, complete state
// in its own right, e.g. if the caller keeps it mounted for a moment or a
// user reopens the app already signed in).

interface AuthorizedScreenProps {
  login: string
  busy: boolean
  onSignOut: () => void
}

export function AuthorizedScreen({ login, busy, onSignOut }: AuthorizedScreenProps): ReactElement {
  return (
    <div className="first-run-screen">
      <h1 className="first-run-heading">You're signed in</h1>
      <p className="first-run-note">
        Signed in as <strong>{displayAccountLogin(login)}</strong>.
      </p>
      <button type="button" className="first-run-button" onClick={onSignOut} disabled={busy}>
        {busy ? 'Signing out…' : 'Sign out'}
      </button>
    </div>
  )
}
