import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// Defines the `--shell-*` custom properties the package stylesheet below
// reads (review finding W1: the package ships no palette by design, and
// nothing in `client/` ever supplied one). Imported first so the tokens
// exist before any `.sb-shell` rule is applied — though for custom
// properties this only matters relative to first paint, not to this import
// itself, since both end up as <style> content in the same document head.
import './theme'
import 'stuffbucket-electron/renderer/styles.css'

import { App } from './App'

// `Window.maximal` is declared once, ambiently, in `shared/window.d.ts`.
//
// This file used to carry its own device-flow UI: it called `createCoreClient`
// and `window.maximal` directly, resolved the control origin once and cached it
// forever, and reimplemented sign-in with inline styles. That was a fourth copy
// of what `first-run/` now does properly, it broke the capability seam every
// other surface respects, and it carried the origin-caching bug (review finding
// H1) that a sidecar restart turns into a permanently dead connection. All of it
// is deleted; this file's whole job is to mount `App`.

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
