import type { ReactElement } from 'react'

// The one terminal-problem screen, parameterized by kind. A user must never
// be stuck staring at a spinner that will never resolve — each of these
// kinds is a distinct, named dead end with a clear way forward, announced
// assertively since each one is blocking the user from continuing.

export type ProblemKind = 'authorization-denied' | 'device-code-expired' | 'offline' | 'fatal'

interface ProblemScreenProps {
  kind: ProblemKind
  message?: string
  remediationUrl?: string
  busy: boolean
  onRestart: () => void
  onOpenUrl: (url: string) => void
}

const COPY: Record<ProblemKind, { heading: string; body: string }> = {
  'authorization-denied': {
    heading: 'Sign-in was denied',
    body: 'The GitHub authorization request was declined. You can try again.',
  },
  'device-code-expired': {
    heading: 'Code expired',
    body: "That code timed out before it was used. Let's get you a new one.",
  },
  offline: {
    heading: "Can't reach GitHub",
    body: 'Maximal is having trouble connecting. Check your network and try again.',
  },
  fatal: {
    heading: 'Something went wrong',
    body: 'Sign-in hit an unexpected problem.',
  },
}

export function ProblemScreen({
  kind,
  message,
  remediationUrl,
  busy,
  onRestart,
  onOpenUrl,
}: ProblemScreenProps): ReactElement {
  const copy = COPY[kind]
  return (
    <div className="first-run-screen">
      <h1 className="first-run-heading">{copy.heading}</h1>
      {/* Assertive: every kind here blocks the user from continuing until
          they act, so each is announced as an interruption, not narration. */}
      <p className="first-run-note first-run-note--error" role="alert">
        {copy.body}
        {message ? ` (${message})` : ''}
      </p>
      <div className="first-run-actions">
        <button type="button" className="first-run-button first-run-button--primary" onClick={onRestart} disabled={busy}>
          {busy ? 'Starting…' : 'Try again'}
        </button>
        {remediationUrl ? (
          <button type="button" className="first-run-link-button" onClick={() => onOpenUrl(remediationUrl)}>
            Learn more
          </button>
        ) : null}
      </div>
    </div>
  )
}
