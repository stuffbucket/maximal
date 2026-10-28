/**
 * Stand-in for `@tauri-apps/api/core` (aliased in .storybook/main.ts).
 * Rejects like the real module does outside a Tauri webview, so callers
 * take the same plain-browser fallback paths they take in `ui:harness`.
 */
export async function invoke<T>(cmd: string, _args?: Record<string, unknown>): Promise<T> {
  throw new Error(`Tauri is not available in Storybook (invoke ${cmd})`);
}

/** Holds its handler and never fires: there is no Rust side to send. */
export class Channel<T = unknown> {
  onmessage: (response: T) => void;

  constructor(onmessage: (response: T) => void = () => {}) {
    this.onmessage = onmessage;
  }
}
