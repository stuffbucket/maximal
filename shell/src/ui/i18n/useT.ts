// React i18n hook. The catalog runtime (`shell/src/i18n`) is deliberately
// DOM- and framework-agnostic: `t()` reads the active locale from module state
// and formats via ICU. Vanilla code repaints on a live locale switch by
// re-running its renderers (`repaintDynamicI18n` in main.ts); an island can't,
// so this hook subscribes to the `maximal:locale-change` event that switch
// emits and forces a re-render, keeping islands in sync without regressing the
// live-switch feature.
import { useSyncExternalStore } from "react"

import { t as translate } from "../../i18n"

export const LOCALE_CHANGE_EVENT = "maximal:locale-change"

// A monotonic version bumped on every locale change. useSyncExternalStore
// re-renders subscribers whenever the snapshot value changes; the number itself
// is meaningless beyond "something changed".
let version = 0

function subscribe(onStoreChange: () => void): () => void {
  const handler = (): void => {
    version += 1
    onStoreChange()
  }
  globalThis.addEventListener(LOCALE_CHANGE_EVENT, handler)
  return () => globalThis.removeEventListener(LOCALE_CHANGE_EVENT, handler)
}

function getSnapshot(): number {
  return version
}

/**
 * Returns the catalog `t()` and re-renders the calling component whenever the
 * active locale changes. `t` itself is a stable reference that reads the
 * current locale internally, so the re-render is what swaps the strings.
 */
export function useT(): typeof translate {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return translate
}
