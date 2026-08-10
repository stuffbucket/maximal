import type { ReactElement } from 'react'

import { AuthorizedScreen } from './AuthorizedScreen'
import { BootScreen } from './BootScreen'
import { assertNever } from './model'
import { PendingScreen } from './PendingScreen'
import { ProblemScreen } from './ProblemScreen'
import { SignInScreen } from './SignInScreen'
import { useFirstRun } from './useFirstRun'

// The first-run orchestrator: switches on `FirstRunPhase.kind` and renders
// exactly one screen component, so there is always exactly one primary
// heading (`<h1>`) on screen. Owns mounting the `useFirstRun` hook and the
// one-time style injection; every screen component below is presentational
// and depends only on its own props.
//
// Resumability is entirely a property of `useFirstRun`/`deriveFirstRunPhase`
// (model.ts, useFirstRun.ts): on mount they read whatever the core lifecycle
// and `auth/status` report right now, so this component itself has no
// "first visit" vs. "reopened" branch to get wrong — every phase below is
// just as reachable on a resumed run as on a fresh one.

export function FirstRun(): ReactElement {
  const { phase, busy, signIn, restart, signOut, openVerificationUrl } = useFirstRun()

  switch (phase.kind) {
    case 'boot':
      return <BootScreen boot={phase.boot} />

    case 'loading':
      return (
        <div className="first-run-screen">
          <h1 className="first-run-heading">Maximal</h1>
          <p className="first-run-note" aria-live="polite">
            Checking sign-in status…
          </p>
        </div>
      )

    case 'signed-out':
      return <SignInScreen busy={busy} onSignIn={signIn} />

    case 'pending':
      return (
        <PendingScreen
          userCode={phase.userCode}
          verificationUri={phase.verificationUri}
          remainingMs={phase.remainingMs}
          polling={phase.polling}
          busy={busy}
          onOpenVerification={openVerificationUrl}
        />
      )

    case 'authorized':
      return <AuthorizedScreen login={phase.login} busy={busy} onSignOut={signOut} />

    case 'authorization-denied':
      return (
        <ProblemScreen
          kind="authorization-denied"
          message={phase.message}
          busy={busy}
          onRestart={restart}
          onOpenUrl={openVerificationUrl}
        />
      )

    case 'device-code-expired':
      return <ProblemScreen kind="device-code-expired" busy={busy} onRestart={restart} onOpenUrl={openVerificationUrl} />

    case 'offline':
      return (
        <ProblemScreen kind="offline" message={phase.message} busy={busy} onRestart={restart} onOpenUrl={openVerificationUrl} />
      )

    case 'fatal':
      return (
        <ProblemScreen
          kind="fatal"
          message={phase.message}
          remediationUrl={phase.remediationUrl}
          busy={busy}
          onRestart={restart}
          onOpenUrl={openVerificationUrl}
        />
      )

    default:
      return assertNever(phase)
  }
}

// ---- Styles ----
//
// Injected once on import (guarded by element id so Vite HMR reloads don't
// pile up duplicate <style> tags — same pattern as workspace/RunCard.tsx and
// settings/Settings.tsx). Every screen component in this directory only
// references these classnames; this file is the single place the rules are
// declared. Values reference the `--shell-*` custom-property contract
// `stuffbucket-electron` publishes, with the same "sensible fallback" idiom
// used elsewhere in this app — this package ships no palette by design.
const FIRST_RUN_CSS = `
.first-run-screen {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--shell-space-3, 12px);
  max-width: 480px;
  margin: 0 auto;
  padding: var(--shell-space-5, 24px);
  color: var(--shell-text, #f5f5f5);
}

.first-run-heading {
  margin: 0;
  font-size: 1.4em;
  font-weight: 600;
}

.first-run-note {
  margin: 0;
  font-size: 0.95em;
  color: var(--shell-text-muted, #8a8a8a);
}

.first-run-note--error {
  color: var(--shell-danger, #ef4444);
}

.first-run-actions {
  display: flex;
  gap: var(--shell-space-2, 8px);
  align-items: center;
}

.first-run-button {
  padding: var(--shell-space-2, 8px) var(--shell-space-4, 16px);
  border: 1px solid var(--shell-border, #2a2a2a);
  border-radius: var(--shell-radius-small, 4px);
  background: transparent;
  color: var(--shell-text, #f5f5f5);
  font: inherit;
  font-size: 0.95em;
  cursor: pointer;
  transition: background-color 150ms ease-out, border-color 150ms ease-out;
}

.first-run-button:hover:not(:disabled) {
  background: var(--shell-hover, rgb(255 255 255 / 0.04));
}

.first-run-button:disabled {
  cursor: default;
  opacity: 0.6;
}

.first-run-button--primary {
  border-color: var(--shell-accent, #5198a6);
  color: var(--shell-accent, #5198a6);
}

.first-run-button:focus-visible,
.first-run-link-button:focus-visible {
  outline: 2px solid var(--shell-focus, var(--shell-accent, #5198a6));
  outline-offset: 2px;
}

.first-run-link-button {
  padding: 0;
  border: none;
  background: none;
  color: var(--shell-accent, #5198a6);
  font: inherit;
  font-size: inherit;
  text-decoration: underline;
  cursor: pointer;
}

.first-run-device-code {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--shell-space-2, 8px);
}

.first-run-device-code__code {
  margin: 0;
  padding: var(--shell-space-2, 8px) var(--shell-space-4, 16px);
  border-radius: var(--shell-radius, 6px);
  background: var(--shell-hover, rgb(255 255 255 / 0.06));
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 1.6em;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.first-run-visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.first-run-spinner {
  width: 20px;
  height: 20px;
  border: 2px solid var(--shell-border, #2a2a2a);
  border-top-color: var(--shell-accent, #5198a6);
  border-radius: 9999px;
  animation: first-run-spin 800ms linear infinite;
}

@keyframes first-run-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .first-run-button {
    transition-duration: 0.01ms;
  }
  .first-run-spinner {
    animation: none;
    /* A static ring still communicates "in progress" without motion. */
    border-top-color: var(--shell-border, #2a2a2a);
    opacity: 0.6;
  }
}
`

const FIRST_RUN_STYLE_ID = 'first-run-styles'

if (typeof document !== 'undefined' && !document.getElementById(FIRST_RUN_STYLE_ID)) {
  const style = document.createElement('style')
  style.id = FIRST_RUN_STYLE_ID
  style.textContent = FIRST_RUN_CSS
  document.head.appendChild(style)
}
