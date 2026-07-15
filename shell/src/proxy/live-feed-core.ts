/**
 * DOM-FREE core of the browser live-feed client (spec §1.2–1.3).
 *
 * Pure helpers the WebSocket glue (`live-feed-client.ts`) composes: tab-id
 * minting, URL derivation, reconnect backoff, and frame parse/serialize. Kept
 * free of `window`/`WebSocket` so it is unit-testable in the repo's DOM-less bun
 * test runner (`tests/ws/live-feed-core.test.ts`).
 */
import type {
  LiveFeedClientMessage,
  LiveFeedServerMessage,
} from "../../../src/lib/ws/feed-types";

/** Structural subset of `sessionStorage` — injected so the core stays DOM-free. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** `sessionStorage` key holding the per-tab presence id (§1.2). */
export const TAB_ID_STORAGE_KEY = "maximal.tabId";

/**
 * Read the stable per-tab id, minting one via `mintId` on first use. `mintId` is
 * injected (browser passes `crypto.randomUUID`) so the core has no global deps.
 */
export function getTabId(storage: StorageLike, mintId: () => string): string {
  const existing = storage.getItem(TAB_ID_STORAGE_KEY);
  if (existing !== null) return existing;
  const minted = mintId();
  storage.setItem(TAB_ID_STORAGE_KEY, minted);
  return minted;
}

/**
 * Derive the WS URL from the inlined bound port + minted token (§1.1/§1.4/§6.5).
 * NOT a hardcoded 4141 — the port comes from `window.__STATE__`.
 */
export function liveFeedUrl(boundPort: number, sessionToken: string): string {
  return `ws://localhost:${boundPort}/ws?key=${encodeURIComponent(sessionToken)}`;
}

/** Bounded exponential backoff for reconnects (§1.3). Pure: attempt → delay ms. */
export function computeBackoffMs(attempt: number): number {
  const BASE_MS = 500;
  const CEILING_MS = 30_000;
  // 2**attempt grows unbounded; the ceiling clamps it. Non-negative attempts
  // only — `attempt` is a reconnect counter (0, 1, 2, …).
  return Math.min(CEILING_MS, BASE_MS * 2 ** Math.max(0, attempt));
}

/** The server frame discriminants the client accepts (mirror of `LiveFeedServerMessage`). */
const SERVER_MESSAGE_TYPES = new Set(["snapshot", "event", "close", "ping"]);

/** Parse an incoming server frame; returns null on malformed input (never throws). */
export function parseServerMessage(raw: string): LiveFeedServerMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("type" in parsed) ||
    typeof (parsed as { type: unknown }).type !== "string" ||
    !SERVER_MESSAGE_TYPES.has((parsed as { type: string }).type)
  ) {
    return null;
  }
  return parsed as LiveFeedServerMessage;
}

/** Serialize an outgoing client frame (hello/visibility/pong). */
export function serializeClientMessage(message: LiveFeedClientMessage): string {
  return JSON.stringify(message);
}
