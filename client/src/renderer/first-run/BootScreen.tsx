import type { ReactElement } from 'react'

import type { BootPhase } from './capabilities'

// The waiting-for-core screen. Renders every `BootPhase` variant, all of
// which are reachable: `main/index.ts` creates the window BEFORE awaiting
// `spawnCore()`, specifically so this screen can narrate `starting` and
// `boot-status` while core is still coming up, and the `live` lifecycle
// adapter (capabilities.ts) relays `onCoreStatus` for the whole sidecar
// lifetime — including a post-ready `crashed`/`restarting` cycle, not just
// the initial boot.
//
// This is the "boot narration, not a blank Starting…" requirement: even the
// `starting` phase gets an explicit, named sentence rather than an empty
// spinner.

interface BootScreenProps {
  boot: BootPhase
}

export function BootScreen({ boot }: BootScreenProps): ReactElement {
  const message = describeBoot(boot)
  const isProblem = boot.phase === 'failed' || (boot.phase === 'crashed' && !boot.willRetry)

  return (
    <div className="first-run-screen">
      <h1 className="first-run-heading">Starting Maximal</h1>
      <p
        className={isProblem ? 'first-run-note first-run-note--error' : 'first-run-note'}
        // Progress narration is polite; a boot failure is promoted to an
        // assertive alert so it interrupts rather than sits quietly under a
        // spinner that will never resolve.
        aria-live={isProblem ? undefined : 'polite'}
        role={isProblem ? 'alert' : undefined}
      >
        {message}
      </p>
      {!isProblem ? <BootSpinner /> : null}
    </div>
  )
}

function describeBoot(boot: BootPhase): string {
  switch (boot.phase) {
    case 'starting':
      return "Starting Maximal's background service…"
    case 'boot-status':
      return boot.message
    case 'ready':
      return 'Ready.'
    case 'crashed':
      return boot.willRetry
        ? "Maximal's background service stopped unexpectedly. Retrying…"
        : "Maximal's background service stopped and could not be restarted."
    case 'restarting':
      return "Restarting Maximal's background service…"
    case 'failed':
      return boot.reason
    case 'stopped':
      return 'Maximal has stopped.'
  }
}

/** Purely decorative — `aria-hidden` and gated by `prefers-reduced-motion`
 *  via CSS (see FirstRun.tsx's injected styles). */
function BootSpinner(): ReactElement {
  return <div className="first-run-spinner" aria-hidden="true" />
}
