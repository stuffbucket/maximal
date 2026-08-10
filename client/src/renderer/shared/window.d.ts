// The single declaration of what the preload bridge exposes on `window`.
//
// This lived in three places — `renderer/main.tsx`, `settings/capabilities.ts`
// and `first-run/capabilities.ts` — written by three agents that could not see
// each other. Two imported `MaximalBridge`; one hand-wrote the shape. They
// merged cleanly while they happened to agree, and broke the moment the bridge
// gained a method, with TS2717 in the two files that were correct rather than
// in the one that was stale. That is the failure mode of duplicated type
// declarations: the error surfaces away from the mistake.
//
// Ambient `.d.ts` rather than a module with `export {}`, so it applies without
// every consumer remembering to import it. Deriving from `typeof bridge` in the
// preload means this cannot drift from what is actually exposed.
import type { MaximalBridge } from '../../preload/index.js'

declare global {
  interface Window {
    maximal: MaximalBridge
  }
}
