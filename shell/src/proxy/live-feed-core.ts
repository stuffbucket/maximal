/**
 * DOM-FREE core of the browser live-feed client (spec §1.2–1.3).
 *
 * Pure helpers the WebSocket glue (`live-feed-client.ts`) composes: tab-id
 * minting, URL derivation, reconnect backoff, and frame parse/serialize. Kept
 * free of `window`/`WebSocket` so it is unit-testable in the repo's DOM-less bun
 * test runner (`tests/ws/live-feed-core.test.ts`).
 */
import { notImplemented } from "../dev/not-implemented";
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
  return notImplemented("getTabId", { storage, mintId });
}

/**
 * Derive the WS URL from the inlined bound port + minted token (§1.1/§1.4/§6.5).
 * NOT a hardcoded 4141 — the port comes from `window.__STATE__`.
 */
export function liveFeedUrl(boundPort: number, sessionToken: string): string {
  return notImplemented("liveFeedUrl", { boundPort, sessionToken });
}

/** Bounded exponential backoff for reconnects (§1.3). Pure: attempt → delay ms. */
export function computeBackoffMs(attempt: number): number {
  return notImplemented("computeBackoffMs", { attempt });
}

/** Parse an incoming server frame; returns null on malformed input (never throws). */
export function parseServerMessage(raw: string): LiveFeedServerMessage | null {
  return notImplemented("parseServerMessage", { raw });
}

/** Serialize an outgoing client frame (hello/visibility/pong). */
export function serializeClientMessage(message: LiveFeedClientMessage): string {
  return notImplemented("serializeClientMessage", { message });
}
