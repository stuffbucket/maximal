import { useEffect, useRef } from "react";

import panelSource from "../../../figjam-plugin/src/legacy/ui.html?raw";

export type FigJamPanelState =
  | "conversation"
  | "pairing"
  | "ready"
  | "selection"
  | "settings";

interface FigJamPluginFrameProps {
  state: FigJamPanelState;
  theme: string;
}

const BOARD_ID = "storybook-product-planning";
const SESSION = "calm-otter";
const MODEL_ID = "claude-sonnet-5-5";

function panelDocument(theme: string): string {
  const dark = theme === "dark";
  const themeClass = dark ? "figma-dark" : theme === "light" ? "figma-light" : "";
  const figmaTheme = dark ? [
    "--figma-color-bg:#2c2c2c",
    "--figma-color-bg-secondary:#383838",
    "--figma-color-bg-tertiary:#444444",
    "--figma-color-bg-hover:#383838",
    "--figma-color-text:#ffffff",
    "--figma-color-border:#444444",
    "--figma-color-border-selected:#0c8ce9",
    "--figma-color-text-disabled:#757575",
    "--figma-color-bg-selected:#2b4a63",
  ].join(";") : "";
  return panelSource.replace(
    "<html",
    `<html data-session="${SESSION}"${themeClass ? ` class="${themeClass}"` : ""}${figmaTheme ? ` style="${figmaTheme}"` : ""}`,
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installFixtureNetwork(win: Window & typeof globalThis, state: FigJamPanelState): void {
  win.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost:4141");
    if (url.pathname === "/v1/models") {
      return json({
        data: [
          { id: MODEL_ID, display_name: "Claude Sonnet 5.5" },
          { id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5" },
        ],
      });
    }
    if (url.pathname === "/v1/messages") {
      return json({
        content: [
          {
            type: "text",
            text: "I grouped the notes into Goals, Risks, and Next steps, then added a short heading to each section.",
          },
        ],
        stop_reason: "end_turn",
      });
    }
    return json({ error: { message: `No FigJam Storybook fixture for ${url.pathname}` } }, 404);
  }) as typeof fetch;

  class FixtureWebSocket {
    static readonly CLOSED = 3;
    static readonly CLOSING = 2;
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;

    readonly url: string;
    readyState = FixtureWebSocket.CONNECTING;
    onclose: ((event: CloseEvent) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onopen: ((event: Event) => void) | null = null;

    constructor(url: string | URL) {
      this.url = String(url);
      queueMicrotask(() => {
        this.readyState = FixtureWebSocket.OPEN;
        this.onopen?.(new Event("open"));
      });
    }

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      if (state !== "pairing" || typeof data !== "string") return;
      try {
        const message = JSON.parse(data) as { type?: unknown };
        if (message.type !== "hello") return;
        queueMicrotask(() => {
          this.onmessage?.(
            new MessageEvent("message", {
              data: JSON.stringify({
                type: "pair-pending",
                name: SESSION,
                expiresInSec: 300,
              }),
            }),
          );
        });
      } catch {
        // The fixture only responds to the bridge's JSON hello message.
      }
    }

    close(code = 1000, reason = ""): void {
      this.readyState = FixtureWebSocket.CLOSED;
      this.onclose?.(new CloseEvent("close", { code, reason, wasClean: true }));
    }
  }

  win.WebSocket = FixtureWebSocket as unknown as typeof WebSocket;
}

function selectionFor(state: FigJamPanelState): Array<Record<string, unknown>> {
  if (state !== "selection" && state !== "conversation") return [];
  return [
    { id: "sticky-1", name: "Customer interviews", type: "STICKY", text: "Shorten setup time" },
    { id: "sticky-2", name: "Team notes", type: "STICKY", text: "Clarify ownership" },
    { id: "sticky-3", name: "Open question", type: "STICKY", text: "Define launch signal" },
  ];
}

function initMessage(state: FigJamPanelState): Record<string, unknown> {
  return {
    type: "init",
    settings: {
      baseUrl: "http://localhost:4141",
      apiKey: "storybook-fixture",
      model: MODEL_ID,
      effort: "medium",
      remote: state === "pairing",
      allowRunCode: false,
      bridgeToken: "",
      bridgeClientId: "",
      window: { mode: "expanded", width: 400, height: 640 },
    },
    selection: selectionFor(state),
    file: {
      name: "Product planning",
      page: "Workshop",
      pageId: "page-1",
      boardId: BOARD_ID,
    },
    boardId: BOARD_ID,
    chats: [],
    tools: [
      {
        name: "get_board",
        description: "Read the current FigJam board.",
        input_schema: { type: "object", properties: {} },
      },
      {
        name: "create_stickies",
        description: "Add sticky notes to the board.",
        input_schema: { type: "object", properties: {} },
      },
    ],
    plugin: { version: "0.1.0", build: "storybook", user: "Storybook" },
    figmaToken: { hasToken: false },
  };
}

function sendPluginMessage(win: Window, message: Record<string, unknown>): void {
  win.postMessage({ pluginMessage: message }, "*");
}

async function waitFor(
  predicate: () => boolean,
  attempts = 80,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return true;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
  }
  return false;
}

async function prepareState(frame: HTMLIFrameElement, state: FigJamPanelState): Promise<void> {
  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  if (doc === null || win === null) return;

  installFixtureNetwork(win as Window & typeof globalThis, state);
  sendPluginMessage(win, initMessage(state));

  const connected = await waitFor(() => {
    const prompt = doc.querySelector<HTMLTextAreaElement>("#prompt");
    const model = doc.querySelector("#modelLabel");
    return prompt?.disabled === false && model?.textContent?.includes("Sonnet") === true;
  });
  if (!connected) return;

  if (state === "conversation") {
    const prompt = doc.querySelector<HTMLTextAreaElement>("#prompt");
    const send = doc.querySelector<HTMLButtonElement>("#go");
    if (prompt && send) {
      prompt.value = "Organize these notes into an action plan";
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
      send.click();
      await waitFor(() => doc.querySelector(".msg.assistant") !== null);
    }
  }

  if (state === "settings" || state === "pairing") {
    doc.querySelector<HTMLButtonElement>("#menuBtn")?.click();
    doc.querySelector<HTMLButtonElement>("#menuSettings")?.click();
    if (state === "pairing") {
      await waitFor(() => doc.querySelector("#bridgeStatus")?.textContent?.includes("Waiting for approval") === true);
    }
  }

  frame.dataset.storybookReady = "true";
}

export function FigJamPluginFrame({ state, theme }: FigJamPluginFrameProps): JSX.Element {
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const target = frame.current?.contentWindow;
      if (target === null || target === undefined || event.source !== target) return;
      const message = (event.data as { pluginMessage?: { type?: unknown } } | null)?.pluginMessage;
      if (message?.type === "chats-list") {
        sendPluginMessage(target, { type: "chats", boardId: BOARD_ID, chats: [] });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <iframe
      key={`${state}-${theme}`}
      ref={frame}
      className="sb-figjam-panel"
      data-storybook-ready="false"
      onLoad={(event) => void prepareState(event.currentTarget, state)}
      srcDoc={panelDocument(theme)}
      title={`FigJam plugin — ${state}`}
    />
  );
}
