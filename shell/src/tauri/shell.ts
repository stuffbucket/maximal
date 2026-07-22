import { invoke } from "@tauri-apps/api/core"

import { readInlineState } from "../proxy/inline-state-client"

// Dependency-injection shim for tests, mirroring update-check.ts / token.ts:
// a process-wide mock.module leaks across sibling test files (ADR-0011 /
// mockModuleLeakGuard), so tests override the IPC transport via
// __setInvokeForTests instead. The narrowed signature is what the real Tauri
// `invoke` and a plain stub are both assignable to.
type InvokeLike = (
  cmd: string,
  args?: Record<string, unknown>,
) => Promise<unknown>

let invokeImpl: InvokeLike = invoke

export function __setInvokeForTests(fn: InvokeLike): void {
  invokeImpl = fn
}

let shellKeyFetched = false
let shellKeyCache: string | null = null

export function __resetShellBridgeForTests(): void {
  invokeImpl = invoke
  shellKeyFetched = false
  shellKeyCache = null
}

export async function getShellApiKey(): Promise<string | null> {
  if (shellKeyFetched) return shellKeyCache
  try {
    shellKeyCache = (await invokeImpl("get_shell_api_key")) as string
  } catch {
    shellKeyCache = null
  }
  // Browser-tab fallback (§1.4/§6.5): the Settings UI is a plain browser tab in
  // the user's default browser, which has NO Tauri host — so `invoke` throws and
  // the shell key is unreachable that way. The sidecar inlines the SAME shell key
  // as `window.__STATE__.sessionToken`, so read it back for `x-api-key` auth on
  // the `/settings/api/*` REST calls (the menu-bar toggle, uninstall, …). Without
  // this, every such call 401s in a browser tab. Empty token → treat as no key.
  if (!shellKeyCache) {
    shellKeyCache = readInlineState(globalThis)?.sessionToken || null
  }
  // eslint-disable-next-line require-atomic-updates -- one-shot memo guard in a single-threaded UI; a concurrent double-fetch is harmless.
  shellKeyFetched = true
  return shellKeyCache
}

export async function openUrl(url: string): Promise<void> {
  await invokeImpl("plugin:opener|open_url", { url })
}

export async function safeInvoke(cmd: string): Promise<boolean> {
  try {
    await invokeImpl(cmd)
    return true
  } catch (err) {
    console.warn(`safeInvoke(${cmd}) failed:`, err)
    return false
  }
}
