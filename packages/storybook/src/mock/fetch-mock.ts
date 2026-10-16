/**
 * Installs the shared mock sidecar (scripts/ui-harness-api.ts) into a
 * browser window by replacing `fetch` and `EventSource` for the UI's
 * backend paths. Everything else passes through to the real globals.
 *
 * Used two ways:
 *   • .storybook/preview.tsx — around every component/island story, with the
 *     scenario + per-path overrides from `parameters.mockApi`;
 *   • window-bootstrap.ts — inside the built Settings/Dashboard pages that
 *     the window stories load in an iframe.
 */
import { type MockBackend, createMockBackend, isMockedPath } from "../../../../scripts/ui-harness-api";
import { SCENARIOS, type ScenarioId, defaultScenarioId } from "../../../../scripts/ui-harness-fixtures";

/** A canned reply for one path; "hang" stays pending forever (loading
 *  states); "offline" fails like Maximal not answering (fetch rejects). */
export type MockOverride = { status: number; body?: unknown } | "hang" | "offline";

export interface MockApiParameters {
  /** Fixture scenario from scripts/ui-harness-fixtures.ts. */
  scenario?: ScenarioId;
  /** Delay before each mocked response, to make transitions visible. */
  latencyMs?: number;
  /** Per-pathname replies that win over the scenario (e.g. an error state). */
  overrides?: Record<string, MockOverride>;
}

export function isScenarioId(value: unknown): value is ScenarioId {
  return typeof value === "string" && value in SCENARIOS;
}

export const scenarioIds = Object.keys(SCENARIOS) as Array<ScenarioId>;

export function scenarioLabel(id: ScenarioId): string {
  return SCENARIOS[id].label;
}

/** Returns a function that restores the original globals. */
export function installMockApi(win: Window & typeof globalThis, params: MockApiParameters = {}): () => void {
  const backend: MockBackend = createMockBackend(params.scenario ?? defaultScenarioId);
  const realFetch = win.fetch;
  const RealEventSource = win.EventSource;

  const mockedPath = (input: string): string | null => {
    const url = new URL(input, win.location.href);
    if (url.origin !== win.location.origin) return null;
    return isMockedPath(url.pathname) ? url.pathname : null;
  };

  win.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input instanceof Request ? input : new URL(String(input), win.location.href), init);
    const path = mockedPath(req.url);
    if (!path) return realFetch(input, init);

    const override = params.overrides?.[path];
    if (override === "hang") return new Promise<Response>(() => {});
    if (override === "offline") throw new TypeError("Failed to fetch");
    if (params.latencyMs) await new Promise((r) => setTimeout(r, params.latencyMs));
    if (override) {
      return new Response(override.body === undefined ? null : JSON.stringify(override.body), {
        status: override.status,
        headers: { "content-type": "application/json" },
      });
    }
    return (await backend.handle(req)) ?? realFetch(input, init);
  }) as typeof fetch;

  // The real client opens one EventSource on /settings/api/events and listens
  // for `auth.changed`. Emulate exactly that; pass any other URL through.
  class MockEventSource extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readyState = 0;
    readonly url: string;
    readonly withCredentials = false;
    onopen: ((ev: Event) => void) | null = null;
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;
    private unsubscribe: () => void = () => {};

    constructor(url: string | URL, init?: EventSourceInit) {
      super();
      this.url = String(url);
      if (mockedPath(this.url) !== "/settings/api/events") {
        // Returning an object from a constructor replaces `this`.
        return new RealEventSource(url, init) as unknown as MockEventSource;
      }
      setTimeout(() => {
        if (this.readyState === 2) return;
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
        this.emit(backend.auth);
        this.unsubscribe = backend.onAuthChange((auth) => this.emit(auth));
      }, 0);
    }

    private emit(auth: unknown): void {
      this.dispatchEvent(new MessageEvent("auth.changed", { data: JSON.stringify(auth) }));
    }

    close(): void {
      this.readyState = 2;
      this.unsubscribe();
    }
  }
  win.EventSource = MockEventSource as unknown as typeof EventSource;

  return () => {
    win.fetch = realFetch;
    win.EventSource = RealEventSource;
  };
}
