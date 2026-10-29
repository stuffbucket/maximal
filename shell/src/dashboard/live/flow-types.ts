export type FlowNodeKind = "model" | "session" | "tool";
export type FlowKind = "input" | "output" | "cache-read" | "cache-write";

export interface FlowNode {
  id: string;
  label: string;
  detail: string;
  kind: FlowNodeKind;
  rate: number;
  share: number;
}

export interface FlowEdge {
  id: string;
  from: string;
  to: string;
  kind: FlowKind;
  rate: number;
}

export interface FlowPalette {
  surface: string;
  text: string;
  muted: string;
  border: string;
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
  fontFamily: string;
  labelFontSize: number;
  detailFontSize: number;
  labelFontWeight: string;
}

export interface FlowSnapshot {
  nodes: Array<FlowNode>;
  edges: Array<FlowEdge>;
  totalRate: number;
  selectedSessionId: string | null;
  reducedMotion: boolean;
  palette: FlowPalette;
}

export type FlowWorkerMessage =
  | {
      type: "init";
      /** A transferred OffscreenCanvas; kept unknown because root tests omit worker DOM types. */
      canvas: unknown;
      width: number;
      height: number;
      scale: number;
    }
  | { type: "resize"; width: number; height: number; scale: number }
  | { type: "snapshot"; snapshot: FlowSnapshot }
  | { type: "active"; active: boolean };
