import { useEffect, useMemo, useState, type ReactElement } from 'react'

import { Dashboard } from './dashboard/Dashboard'
import { FirstRun } from './first-run/FirstRun'
import { Settings } from './settings/Settings'
import { createCoreSettingsCapabilities } from './settings/capabilities'
import { Workspace } from './workspace/Workspace'
import { createPlaceholderSource } from './workspace/source'

/**
 * Top-level composition.
 *
 * This is the one place that decides which surface is showing, and it exists
 * because that decision cannot be made by any surface individually — each of
 * `first-run/`, `workspace/`, `dashboard/` and `settings/` was built to be
 * mounted, and none of them could know what mounts it.
 *
 * Auth gates the app: `first-run/` owns everything up to and including a
 * completed device flow — which is also where boot narration lives, since it is
 * the only surface that can be on screen while the sidecar is still starting.
 * Once authenticated, the working surfaces take over.
 *
 * Nothing here touches `ControlClient` or `window.maximal`. It reads auth
 * through the Settings capability seam; that adapter is the sole renderer
 * boundary to the named main-process bridge.
 */

/** How often to re-read auth status while nothing is pushing changes.
 *  `subscribe()` is the fast path; this is the safety net for a missed or
 *  renamed event — the same fallback every other auth-status consumer in
 *  this app already has (`settings/AccountSection.tsx`,
 *  `first-run/useFirstRun.ts`). This file was the one exception (review
 *  finding M3): it gates the ENTIRE app on `authenticated`, so a push this
 *  consumer alone missed didn't just show a stale value somewhere — it
 *  stranded a signed-in user on the first-run screen with no route back in
 *  until something else happened to re-trigger a read. */
const POLL_MS = 3_000

type View = 'dashboard' | 'workspace' | 'settings'

const VIEWS: ReadonlyArray<{ id: View; label: string }> = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'workspace', label: 'Runs' },
  { id: 'settings', label: 'Settings' },
]

export function App(): ReactElement {
  // Built once for the app's lifetime. Electron main owns sidecar replacement;
  // this adapter keeps one stable named-bridge subscription across restarts.
  // Recreating it per render would drop live subscriptions and defeat that.
  const settings = useMemo(() => createCoreSettingsCapabilities(), [])
  const source = useMemo(() => createPlaceholderSource(), [])

  const [authenticated, setAuthenticated] = useState<boolean | null>(null)
  const [view, setView] = useState<View>('dashboard')

  useEffect(() => {
    let cancelled = false

    const refresh = async (): Promise<void> => {
      try {
        const status = await settings.account.status()
        if (!cancelled) setAuthenticated(status.state === 'authenticated')
      } catch {
        // Core unreachable or still starting. Leave the current answer alone —
        // `null` keeps showing first-run, which is where boot status renders,
        // and flipping an authenticated user out of the app on one transient
        // failure would be worse than waiting.
      }
    }

    void refresh()
    const unsubscribe = settings.subscribe(() => void refresh())
    const poll = setInterval(() => void refresh(), POLL_MS)
    return () => {
      cancelled = true
      unsubscribe()
      clearInterval(poll)
    }
  }, [settings])

  // `null` means "not answered yet" and is deliberately NOT treated as signed
  // out: first-run handles both the pre-auth and the still-booting cases, so
  // rendering it while the answer is unknown is correct rather than a fallback.
  if (authenticated !== true) return <FirstRun />

  return (
    <div className="app-shell">
      <nav className="app-shell__views" aria-label="Views">
        {VIEWS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            className="app-shell__view-tab"
            aria-current={view === id ? 'page' : undefined}
            onClick={() => setView(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="app-shell__surface">
        {view === 'dashboard' ? <Dashboard source={source} /> : null}
        {view === 'workspace' ? <Workspace source={source} /> : null}
        {view === 'settings' ? <Settings capabilities={settings} /> : null}
      </div>
    </div>
  )
}

// ---- Styles ----
//
// Injected once on import, guarded by element id — same pattern as
// `settings/Settings.tsx` and `workspace/RunCard.tsx`. Three things live here
// that no other file owns:
//
// 1. The height chain. `.sb-shell.app` (the package's root class, applied by
//    `ShellLayout` inside Dashboard/Workspace) is `height: 100%`, and nothing
//    between it and the viewport established a height: `index.html` sets
//    none on `html`/`body`/`#root`, and these `app-shell*` classnames had no
//    CSS at all before this file. A percentage height against an `auto`
//    containing block resolves to `auto`, so the three-panel frame was
//    sizing to its content instead of the window — the whole document
//    scrolled, taking the tab strip and status bar with it. Fixed here
//    rather than in `index.html` so the whole chain lives with the
//    component that depends on it.
// 2. Rules for `app-shell`, `app-shell__views` and `app-shell__view-tab` —
//    this file's own primary navigation. Unlike every other surface here, it
//    used to inject no `<style>` block at all, so the three view buttons
//    were unstyled UA chrome (light-gray boxes, black labels) on the dark
//    window, and the selected view was marked only by `aria-current`, for
//    which no rule existed. `[aria-current='page']` below carries the
//    selection two ways — colour AND weight — so it is not colour alone.
// 3. Two `stuffbucket-electron` package stylesheet gaps, found by rendering
//    the packaged app at 760x620 and comparing screenshots to actual pixels
//    (measuring `.app-shell__surface`'s rect against `innerHeight` reported
//    "fills the window, no overflow" while the window visibly showed
//    overlapping nav text and two scrollbars — a metric that lied). Both
//    gaps live in `dist/renderer/styles.css`, not in any client container, so
//    they are overridden here with `.app-shell`-qualified selectors (higher
//    specificity than the package's own two-class rules, so this wins
//    regardless of `<style>` injection order) rather than "fixed" by
//    restructuring a client container that was already correct:
//      a. `.nav__label` carries no `white-space`/`overflow` rule, so a label
//         too long for the rail (e.g. "Placeholder Project — Aurora") wraps
//         to a second line inside a `.nav__item` whose height is a hardcoded
//         30px — the wrapped line renders on top of the next item's row.
//         Truncating with an ellipsis keeps every row at its fixed height.
//      b. `.statusbar` is `height: 24px` (not `min-height`), so when its
//         `<span>` children (no `white-space: nowrap`) don't fit the
//         available width, they wrap and the wrapped text overflows the
//         fixed-height box both upward (colliding with the run cards above)
//         and downward (cut off at the window's bottom edge). That overflow
//         sits inside `.panel--canvas`, which `react-resizable-panels`
//         always renders with an inline `overflow: auto` — so the overflow
//         also opened a second, redundant scrollbar next to `.canvas`'s own
//         legitimate one. `height: auto` with a `min-height` floor lets the
//         row grow to fit wrapped text instead of fighting it, which fixes
//         both the clipped status bar and the doubled scrollbar in one
//         change.
const APP_SHELL_CSS = `
html,
body,
#root {
  height: 100%;
  margin: 0;
}

/*
 * The window background belongs on the DOCUMENT, not on \`.app-shell\`.
 *
 * \`.app-shell\` only exists once the user is authenticated — signed out, \`App\`
 * returns \`<FirstRun />\` directly with no wrapper — so putting the background
 * there left first-run painting \`--shell-text\` (#f5f5f5) on Chromium's default
 * white canvas: 1.09:1, i.e. near-invisible, on the FIRST screen a new user
 * sees. Caught by the packaged suite's new contrast assertion on unmodified
 * code, which is exactly the regression class it was added for.
 *
 * Setting \`color\` here too means any surface rendered outside \`.app-shell\`
 * inherits a legible pair rather than depending on its own rules.
 */
html,
body {
  color: var(--shell-text, #f5f5f5);
  background: var(--shell-background, #16181d);
}

.app-shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  color: var(--shell-text, #f5f5f5);
  background: var(--shell-background, #16181d);
  font: 400 14px/1.5 system-ui, sans-serif;
}

.app-shell__views {
  display: flex;
  flex: none;
  gap: var(--shell-space-2, 8px);
  padding: var(--shell-space-2, 8px) var(--shell-space-4, 16px);
  border-bottom: 1px solid var(--shell-border, #2a2a2a);
  background: var(--shell-background, #16181d);
}

.app-shell__view-tab {
  appearance: none;
  border: 0;
  border-radius: var(--shell-radius, 6px);
  padding: var(--shell-space-2, 8px) var(--shell-space-3, 12px);
  color: var(--shell-text-muted, #8a8a8a);
  background: transparent;
  font: inherit;
  cursor: pointer;
}

.app-shell__view-tab:hover {
  color: var(--shell-text, #f5f5f5);
  background: var(--shell-hover, rgb(255 255 255 / 0.06));
}

.app-shell__view-tab[aria-current='page'] {
  color: var(--shell-accent, #5198a6);
  background: var(--shell-accent-muted, rgb(81 152 166 / 0.12));
  font-weight: 500;
}

.app-shell__view-tab:focus-visible {
  outline: 2px solid var(--shell-focus, var(--shell-accent, #5198a6));
  outline-offset: 2px;
}

.app-shell__surface {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  overflow: auto;
}

.app-shell .sb-shell .nav__label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.app-shell .sb-shell .statusbar {
  height: auto;
  min-height: 24px;
  flex-wrap: wrap;
  row-gap: var(--shell-space-1, 4px);
  padding-top: var(--shell-space-1, 4px);
  padding-bottom: var(--shell-space-1, 4px);
}
`

const APP_SHELL_STYLE_ID = 'app-shell-styles'

if (typeof document !== 'undefined' && !document.getElementById(APP_SHELL_STYLE_ID)) {
  const style = document.createElement('style')
  style.id = APP_SHELL_STYLE_ID
  style.textContent = APP_SHELL_CSS
  document.head.appendChild(style)
}
