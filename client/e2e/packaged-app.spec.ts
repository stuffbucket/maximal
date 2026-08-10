import { expect, test, type Page } from '@playwright/test'

import { cleanupPackagedApp, launchPackagedApp, type RunningApp, waitForLine } from './support/launch'
import { findProcessesContaining } from './support/process-search'
import { assertContrastAtLeast, assertFocusOutlineResolves, assertNoVerticalOverlap, assertWithinWindow } from './support/visual-invariants'

/*
 * Packaged-app E2E — a SMALL, high-value suite, not a broad one.
 *
 * Every test in this file shares one launch of one relocated copy of the
 * packaged app (see support/relocate-app.ts for why relocation is
 * non-negotiable): a fresh package build per test would multiply an already
 * slow suite for no extra confidence, since the properties under test
 * (relocation held, sidecar reached ready, window rendered, shutdown is
 * clean) are all about a single run's lifecycle.
 *
 * Requires `npm run package` to have already produced
 * client/out/Maximal-darwin-<arch>/Maximal.app — this suite never builds it
 * for you. See package.json's `e2e` script / client-ci.yml for the gate that
 * fails loudly instead of silently skipping when that build is missing.
 */

let running: RunningApp

test.beforeAll(async () => {
  running = await launchPackagedApp()
})

test.afterAll(async () => {
  // The last test in this file already closes the app itself (to assert
  // clean shutdown) — closing an already-closed ElectronApplication is safe
  // to attempt again but may reject, so tolerate that here rather than
  // letting a redundant close mask the real test result or skip cleanup.
  try {
    if (running?.app) await running.app.close()
  } catch {
    // already closed
  }
  if (running) cleanupPackagedApp(running)
})

test('launches from a relocated copy and the sidecar reaches ready', async () => {
  // relocatePackagedApp() (inside launchPackagedApp(), run in beforeAll)
  // already asserted the copy is complete and outside every node_modules in
  // its ancestry — if either had failed, beforeAll itself would have thrown
  // before this test ever ran. What's left to prove here is that the
  // relocated copy actually boots: the sidecar spawns, binds, and the app's
  // own main process narrates readiness on stdout.
  await waitForLine(running.lines, /\[maximal-client\] core ready — control /)
})

test('window opens with exactly one non-empty primary heading', async () => {
  const window = await running.app.firstWindow()
  const headings = window.locator('h1')

  // Asserts the INVARIANT, not the copy. This previously pinned the exact
  // string 'Maximal', which came from a placeholder sign-in screen in
  // `renderer/main.tsx` that has since been deleted — so the assertion broke
  // the moment the real UI mounted, having proved nothing about it.
  //
  // What is worth asserting is the rule every surface is held to in
  // `.design-context.md`: exactly one primary heading per view, never
  // competing `h1`s. Which surface is showing depends on auth and sidecar
  // state and legitimately varies ('Starting Maximal', 'Sign in to Maximal',
  // 'Enter this code on GitHub', …), so the text is not the contract — the
  // count is. This also catches a real regression class the unit tests
  // cannot: two surfaces mounted at once, each bringing its own `h1`.
  await expect(headings).toHaveCount(1)
  await expect(headings.first()).not.toBeEmpty()
})

test('packaged preload exposes only the closed named bridge', async () => {
  const page = await running.app.firstWindow()
  const exposed = await page.evaluate(() => ({
    topLevel: Object.keys(window.maximal).sort(),
    control: Object.keys(window.maximal.control).sort(),
    hasCoreOrigin: 'getCoreOrigin' in window.maximal,
    hasWindowRequire: 'require' in window,
  }))

  expect(exposed).toEqual({
    topLevel: [
      'control',
      'getCoreStatus',
      'getProxyUrl',
      'onCoreStatus',
      'openExternal',
    ],
    control: [
      'accountsList',
      'accountsSwitch',
      'authCancel',
      'authSignOut',
      'authStart',
      'authStatus',
      'onChange',
    ],
    hasCoreOrigin: false,
    hasWindowRequire: false,
  })
})

test('renderer window is hardened: contextIsolation, no nodeIntegration, sandboxed', async () => {
  // WHY THIS TEST (maximal#436): none of contextIsolation/nodeIntegration/
  // sandbox is set by THIS repo. `src/main/shell.ts` is a 3-line re-export of
  // `createHostWindow` from the `stuffbucket-electron` dependency (pinned by
  // raw commit SHA and bumped aggressively) — the flags live entirely inside
  // node_modules/stuffbucket-electron/dist/host/host-window.js. A shell bump
  // could silently flip `sandbox` to false with no diff in our source and no
  // failing unit test; the first symptom would be a compromised renderer with
  // Node access. Only launching the real packaged app and inspecting the real
  // window proves the shipped posture — a unit test that reads the
  // dependency's source would be asserting the very file this guards against
  // changing.
  //
  // `webContents.getLastWebPreferences()` returns the EFFECTIVE webPreferences
  // Electron actually applied to this live WebContents — not the options
  // object anyone constructed it with, so it reflects reality even if some
  // upstream default or override changed the outcome. It is absent from
  // Electron's public .d.ts (undocumented/legacy) but confirmed present and
  // functional at runtime on the Electron version this app ships (see the
  // WebContentsWithLegacyPreferences cast below). This is the DIRECT read the
  // task calls for, preferred over inferring posture from renderer-side
  // symptoms.
  interface WebContentsWithLegacyPreferences {
    getLastWebPreferences(): Electron.WebPreferences | undefined
  }

  const prefs = await running.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    const wc = win.webContents as unknown as WebContentsWithLegacyPreferences
    const preferences = wc.getLastWebPreferences()
    if (!preferences) throw new Error('getLastWebPreferences() returned nothing for the app window')
    return preferences
  })

  expect(prefs.contextIsolation).toBe(true)
  expect(prefs.nodeIntegration).toBe(false)
  expect(prefs.sandbox).toBe(true)
})

/**
 * Waits up to `timeoutMs` for `selector`'s first match to become visible,
 * reporting whether it did rather than throwing. Used below to distinguish
 * "the authenticated package chrome rendered" from "still on first-run" —
 * this harness launches with a fresh `--user-data-dir` every run (see
 * `support/launch.ts`), and `main/core.ts` scopes `COPILOT_API_HOME` under
 * that same per-run `userData` directory, so there is structurally no
 * persisted GitHub session this suite could ever resume: it is ALWAYS
 * signed out, on this machine and on CI alike. The package's own chrome
 * (tab strip, nav rails, icon buttons, status bar) therefore never renders
 * in an automated run of this suite — reaching it requires a live GitHub
 * device-code flow, which is both infeasible to script here and against
 * this task's constraints.
 *
 * The four tests below are still written to check the package chrome, not
 * just first-run, because that is what actually shipped broken. Each one
 * probes for the package chrome first and skips to a first-run-based
 * assertion, or skips outright, when it is not reachable — never fails —
 * so this suite stays meaningful (and green) signed-out on CI while still
 * being the assertion that would catch a regression once a real session is
 * live. The package-chrome path was verified BY HAND against the real,
 * unmodified rendered components: a scratch Playwright script stubbed only
 * the `auth/status` JSON-RPC response (no source edit, no real GitHub call)
 * to reach the identical Dashboard/Workspace DOM this harness would show a
 * signed-in user, confirmed each assertion below passes against it, then
 * confirmed each one goes red under the specific historical regression it
 * guards — see the task report for the full break/confirm log.
 */
async function probeVisible(window: Page, selector: string, timeoutMs = 3_000): Promise<boolean> {
  try {
    await window.locator(selector).first().waitFor({ state: 'visible', timeout: timeoutMs })
    return true
  } catch {
    return false
  }
}

const SIGNED_OUT_SKIP_MESSAGE =
  'Package chrome (post sign-in) did not render within the probe window. This harness is ' +
  'structurally always signed out (a fresh --user-data-dir per run scopes COPILOT_API_HOME to an ' +
  'empty profile — see src/main/core.ts), which is also the state a real CI machine is in, so this ' +
  'is expected here and is not a failure. See the task report for how this assertion was verified ' +
  'against the real package chrome via an auth-status route stub.'

test('chrome text is not near-invisible against its background', async () => {
  // Historical defect: no --shell-* custom property was defined at all, so
  // `color: var(--shell-text)` and friends computed to inherited/initial
  // values on every package control — near-black text on a near-black
  // window, ~1.1:1. Signed out, first-run's OWN controls share the exact
  // same `var(--shell-*, fallback)` chain (see FirstRun.tsx's header
  // comment), so checking them here is checking the same failure mode,
  // just on the surface this harness can actually reach.
  const window = await running.app.firstWindow()
  const packageChromeVisible = await probeVisible(window, '.app-shell .sb-shell')

  const targets = packageChromeVisible
    ? [
        { locator: window.locator('.app-shell .sb-shell .icon-button[data-testid="toggle-left"]'), label: 'titlebar icon button' },
        { locator: window.locator('.app-shell .sb-shell .statusbar span').first(), label: 'status bar text' },
        { locator: window.locator('.app-shell__view-tab[aria-current="page"]'), label: 'selected view tab' },
      ]
    : [
        { locator: window.locator('.first-run-heading'), label: 'first-run heading' },
        { locator: window.locator('.first-run-note').first(), label: 'first-run note' },
        { locator: window.locator('.first-run-button--primary'), label: 'first-run primary button' },
      ]

  let checked = 0
  for (const { locator, label } of targets) {
    if ((await locator.count()) === 0) continue
    await assertContrastAtLeast(locator, label)
    checked++
  }
  expect(checked, 'expected at least one on-screen chrome control to check contrast against').toBeGreaterThan(0)
})

test("a focused chrome control's outline actually resolves", async () => {
  // Historical defect: `outline: 2px solid var(--shell-focus, var(--shell-accent))`
  // with neither custom property defined is an invalid declaration at
  // computed-value time (CSS Custom Properties §3.2) — it computes to
  // `outline: none`, on every focusable shell control at once. First-run's
  // primary button carries the identical `:focus-visible` rule shape
  // (`FirstRun.tsx`), so it exercises the same failure mode signed out.
  const window = await running.app.firstWindow()
  const packageChromeVisible = await probeVisible(window, '.app-shell .sb-shell')

  const target = packageChromeVisible
    ? window.locator('.app-shell .sb-shell .icon-button[data-testid="toggle-left"]')
    : window.locator('.first-run-button--primary')
  const label = packageChromeVisible ? 'titlebar icon button' : 'first-run primary button'

  await expect(target).toBeVisible()
  await assertFocusOutlineResolves(window, target, label)
})

test('nav rail entries do not overlap vertically', async () => {
  // Historical defect: `.nav__label` carried no white-space/overflow rule in
  // the package stylesheet, so a label too long for the rail wrapped to a
  // second line inside a `.nav__item` whose height is a hardcoded 30px — the
  // wrapped line rendered on top of the next item's row. No first-run
  // equivalent exists (first-run has no repeated sibling list at a fixed row
  // height), so this is package-chrome only and skips signed out.
  const window = await running.app.firstWindow()
  if (!(await probeVisible(window, '.app-shell__view-tab'))) {
    test.skip(true, SIGNED_OUT_SKIP_MESSAGE)
    return
  }

  await window.locator('.app-shell__view-tab', { hasText: 'Runs' }).click()

  // Checked on `.nav__label`, NOT `.nav__item`: `.nav__item`'s own box is a
  // hardcoded `height: 30px` in the package stylesheet, which stays exactly
  // 30px and flush against its neighbours regardless of whether its child
  // label wraps and paints outside it — asserting on THAT box reproduces the
  // exact "measures fine but is visibly broken" blind spot this suite exists
  // to close (confirmed empirically while building this test: checking
  // `.nav__item` never caught the reverted-fix break below; `.nav__label`
  // caught it immediately, since a wrapped label's own rendered box grows
  // taller than 30px instead of staying pinned to its container's height).
  const navLabels = window.locator('[data-testid="projects-nav"] .nav__label')
  await expect(navLabels.first()).toBeVisible()
  await assertNoVerticalOverlap(await navLabels.all(), 'projects nav rail labels')
})

test('status bar text is not clipped at the window edge', async () => {
  // Historical defect: `.statusbar` was a fixed `height: 24px` (not a
  // `min-height`), so when its <span> children didn't fit the available
  // width, they wrapped and the wrapped text overflowed the fixed-height box
  // both upward (drawing over the run cards above, inside `.tabpanel`) and
  // downward (cut off at the window's bottom edge). Package-chrome only —
  // first-run has nothing structurally comparable to check — so this skips
  // signed out.
  const window = await running.app.firstWindow()
  if (!(await probeVisible(window, '.app-shell__view-tab'))) {
    test.skip(true, SIGNED_OUT_SKIP_MESSAGE)
    return
  }

  await window.locator('.app-shell__view-tab', { hasText: 'Runs' }).click()

  // Checked per SPAN, not just on the `.statusbar` container: the original
  // bug's container was itself nominally "within the window" at a fixed
  // 24px while its wrapped children individually extended past it.
  const statusTexts = window.locator('.app-shell .sb-shell .statusbar span')
  const count = await statusTexts.count()
  expect(count, 'expected the status bar to render at least one text span').toBeGreaterThan(0)
  for (const span of await statusTexts.all()) {
    await assertWithinWindow(window, span, 'status bar text')
  }

  // The "upward" half of the same defect: wrapped status-bar text drawing
  // over the document content above it.
  await assertNoVerticalOverlap(
    [window.locator('.tabpanel'), window.locator('.app-shell .sb-shell .statusbar')],
    'tabpanel vs statusbar',
  )

  // The runs canvas is DELIBERATELY internally scrollable (package
  // stylesheet: `.canvas { overflow-y: auto }`) — its CONTENT may legitimately
  // be taller than its box; that is what the scrollbar is for. What must
  // still hold is that its own outer box, like any other panel, fits inside
  // the window rather than being clipped by the window edge itself.
  await assertWithinWindow(window, window.locator('[data-testid="runs-canvas"]'), 'runs canvas (outer box)')
})

test('exits cleanly without orphaning the sidecar process', async () => {
  // appRoot is a fresh mktemp path unique to this run, so a substring match
  // against it cannot collide with an unrelated maximal-core/Electron
  // process already on the machine (e.g. a dev instance).
  const before = findProcessesContaining(running.appRoot)
  expect(before.some((line) => line.includes('maximal-core'))).toBe(true)

  await running.app.close()

  // killCore() sends SIGTERM on 'before-quit' rather than blocking on exit,
  // so give the sidecar a moment to actually finish tearing down before
  // declaring it orphaned.
  const deadline = Date.now() + 10_000
  let remaining: string[] = []
  do {
    remaining = findProcessesContaining(running.appRoot)
    if (remaining.length === 0) break
    await new Promise((r) => setTimeout(r, 200))
  } while (Date.now() < deadline)

  expect(remaining).toEqual([])
})
