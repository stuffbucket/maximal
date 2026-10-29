import type { SimulationNodeDatum } from "d3-force";

import { forceCollide, forceSimulation, forceX, forceY } from "d3-force";

import type {
  FlowEdge,
  FlowKind,
  FlowNode,
  FlowPalette,
  FlowSnapshot,
  FlowWorkerMessage,
} from "./flow-types";

interface Point {
  x: number;
  y: number;
}

interface WorkerCanvas {
  width: number;
  height: number;
  getContext(contextId: "2d"): CanvasRenderingContext2D | null;
}

interface PositionedNode extends FlowNode, Point {
  angle: number;
  labelX: number;
  labelY: number;
  align: CanvasTextAlign;
}

interface Particle {
  edgeId: string;
  kind: FlowKind;
  age: number;
  travelMs: number;
  restMs: number;
  arc: number;
  slot: number;
}

const FRAME_MS = 1000 / 30;
const MAX_PARTICLES = 140;
const TAU = Math.PI * 2;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const compactNumbers = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

let canvas: WorkerCanvas | null = null;
let context: CanvasRenderingContext2D | null = null;
let width = 0;
let height = 0;
let scale = 1;
let snapshot: FlowSnapshot | null = null;
let positioned = new Map<string, PositionedNode>();
let particles: Array<Particle> = [];
let active = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastFrame = 0;
let randomState = 0x7f4a7c15;
let arrivalSeq = 0;
let labelsDirty = true;

const random = (): number => {
  randomState ^= randomState << 13;
  randomState ^= randomState >>> 17;
  randomState ^= randomState << 5;
  return (randomState >>> 0) / 0x1_0000_0000;
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

function resize(nextWidth: number, nextHeight: number, nextScale: number): void {
  if (!canvas) return;
  width = Math.max(0, nextWidth);
  height = Math.max(0, nextHeight);
  scale = clamp(nextScale, 1, 2);
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  context?.setTransform(scale, 0, 0, scale, 0, 0);
  positioned = positionNodes(snapshot?.nodes ?? []);
  labelsDirty = true;
  draw();
}

function arcPositions(
  nodes: Array<FlowNode>,
  center: Point,
  radiusX: number,
  radiusY: number,
  from: number,
  to: number,
): Array<PositionedNode> {
  return nodes.map((node, index) => {
    const fraction = nodes.length === 1 ? 0.5 : index / (nodes.length - 1);
    const angle = from + (to - from) * fraction;
    const outward = { x: Math.cos(angle), y: Math.sin(angle) };
    const x = center.x + outward.x * radiusX;
    const y = center.y + outward.y * radiusY;
    return {
      ...node,
      x,
      y,
      angle,
      labelX: x,
      labelY: y,
      align: "center",
    };
  });
}

function positionNodes(nodes: Array<FlowNode>): Map<string, PositionedNode> {
  const result = new Map<string, PositionedNode>();
  if (width <= 0 || height <= 0) return result;
  const center = { x: width / 2, y: height / 2 };
  const ringScale = Math.min(width, height);
  const radiusX = Math.max(55, ringScale * 0.32);
  const radiusY = radiusX;
  const models = nodes.filter((node) => node.kind === "model");
  const sessions = nodes.filter((node) => node.kind === "session");
  const tools = nodes.filter((node) => node.kind === "tool");
  const placed = [
    ...arcPositions(models, center, radiusX, radiusY, Math.PI * 1.17, Math.PI * 1.83),
    ...arcPositions(sessions, center, radiusX, radiusY, Math.PI * 0.17, Math.PI * 0.83),
    ...arcPositions(tools, center, radiusX, radiusY, -0.02 * Math.PI, 1.02 * Math.PI),
  ];
  for (const node of placed) result.set(node.id, node);
  return result;
}

function desiredParticleCount(totalRate: number): number {
  if (totalRate <= 0) return 0;
  return clamp(Math.round(26 + Math.log10(totalRate + 1) * 21), 32, MAX_PARTICLES);
}

function particleScaleText(totalRate: number, palette: FlowPalette): string {
  const count = Math.max(1, desiredParticleCount(totalRate));
  const tokensPerSecond = totalRate / 60 / count;
  return palette.particleScaleTemplate.replace("__RATE__", compactNumbers.format(tokensPerSecond));
}

function weightedEdge(edges: Array<FlowEdge>): FlowEdge | undefined {
  const total = edges.reduce((sum, edge) => sum + Math.max(0, edge.rate), 0);
  if (total <= 0) return undefined;
  let cursor = random() * total;
  for (const edge of edges) {
    cursor -= Math.max(0, edge.rate);
    if (cursor <= 0) return edge;
  }
  return edges.at(-1);
}

function newParticle(edge: FlowEdge, initial = false): Particle {
  const travelMs = 1_000 + random() * 900;
  const restMs = 220 + random() * 300;
  return {
    edgeId: edge.id,
    kind: edge.kind,
    age: initial ? random() * (travelMs + restMs) : 0,
    travelMs,
    restMs,
    arc: (random() - 0.5) * 0.32,
    slot: arrivalSeq++,
  };
}

function rebalanceParticles(edges: Array<FlowEdge>, desired: number): void {
  const totalRate = edges.reduce((sum, edge) => sum + edge.rate, 0);
  if (totalRate <= 0) return;
  const allocations = edges.map((edge) => {
    const exact = (desired * edge.rate) / totalRate;
    return { edge, count: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let unassigned = desired - allocations.reduce((sum, allocation) => sum + allocation.count, 0);
  for (const allocation of [...allocations].sort((a, b) => b.remainder - a.remainder)) {
    if (unassigned <= 0) break;
    allocation.count++;
    unassigned--;
  }

  const byEdge = new Map<string, Array<Particle>>();
  for (const particle of particles) {
    const group = byEdge.get(particle.edgeId);
    if (group) group.push(particle);
    else byEdge.set(particle.edgeId, [particle]);
  }
  const available: Array<Particle> = [];
  for (const allocation of allocations) {
    const group = byEdge.get(allocation.edge.id) ?? [];
    if (group.length > allocation.count) available.push(...group.splice(allocation.count));
  }
  for (const allocation of allocations) {
    const group = byEdge.get(allocation.edge.id) ?? [];
    let missing = allocation.count - group.length;
    while (missing > 0) {
      const particle = available.pop();
      if (!particle) break;
      Object.assign(particle, newParticle(allocation.edge));
      missing--;
    }
  }
}

function reconcileParticles(initial = false, rebalance = false): void {
  if (!snapshot) {
    particles = [];
    return;
  }
  const edges = snapshot.edges.filter(
    (edge) => edge.rate > 0 && positioned.has(edge.from) && positioned.has(edge.to),
  );
  const desired = desiredParticleCount(snapshot.totalRate);
  particles = particles.filter((particle) => edges.some((edge) => edge.id === particle.edgeId));
  if (particles.length > desired) particles.length = desired;
  while (particles.length < desired) {
    const edge = weightedEdge(edges);
    if (!edge) break;
    particles.push(newParticle(edge, initial));
  }
  if (rebalance) rebalanceParticles(edges, desired);
}

function nextEdge(current: FlowEdge, edges: Array<FlowEdge>): FlowEdge | undefined {
  const reverse = edges.filter((edge) => edge.from === current.to && edge.to === current.from);
  const reverseRate = reverse.reduce((sum, edge) => sum + edge.rate, 0);
  const reverseChance = reverseRate / Math.max(1, current.rate + reverseRate);
  if (reverse.length > 0 && random() < Math.min(0.5, reverseChance)) return weightedEdge(reverse);
  const outgoing = edges.filter((edge) => edge.from === current.to);
  return weightedEdge(outgoing.length > 0 ? outgoing : edges);
}

function reverseParticle(particle: Particle, edge: FlowEdge): void {
  const replacement = newParticle(edge);
  replacement.arc = -particle.arc;
  Object.assign(particle, replacement);
}

function particlePosition(particle: Particle, edge: FlowEdge): { point: Point; alpha: number } | null {
  const from = positioned.get(edge.from);
  const to = positioned.get(edge.to);
  if (!from || !to) return null;
  if (particle.age < particle.travelMs) {
    const raw = clamp(particle.age / particle.travelMs, 0, 1);
    const progress = raw;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const bend = Math.hypot(dx, dy) * particle.arc * Math.sin(Math.PI * progress);
    const length = Math.max(1, Math.hypot(dx, dy));
    return {
      point: {
        x: from.x + dx * progress + (-dy / length) * bend,
        y: from.y + dy * progress + (dx / length) * bend,
      },
      alpha: 1,
    };
  }

  const resting = particle.age - particle.travelMs;
  const dwell = clamp(resting / particle.restMs, 0, 1);
  const angle = particle.slot * GOLDEN_ANGLE;
  const radius = 4 + (particle.slot % 4) * 1.5;
  return {
    point: { x: to.x + Math.cos(angle) * radius, y: to.y + Math.sin(angle) * radius },
    alpha: 1 - dwell * 0.2,
  };
}

function particleColor(kind: FlowKind, palette: FlowPalette): string {
  if (kind === "input") return palette.input;
  if (kind === "output") return palette.output;
  if (kind === "cache-read") return palette.cacheRead;
  return palette.cacheWrite;
}

function drawStaticConnections(ctx: CanvasRenderingContext2D, palette: FlowPalette): void {
  if (!snapshot) return;
  const totalRate = Math.max(1, snapshot.edges.reduce((sum, edge) => sum + edge.rate, 0));
  const offsets: Record<FlowKind, number> = {
    input: -6,
    output: 6,
    "cache-read": -14,
    "cache-write": 14,
  };
  for (const edge of snapshot.edges) {
    const from = positioned.get(edge.from);
    const to = positioned.get(edge.to);
    if (!from || !to || edge.rate <= 0) continue;
    const color = particleColor(edge.kind, palette);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.max(1, Math.hypot(dx, dy));
    const control = {
      x: (from.x + to.x) / 2 + (-dy / length) * offsets[edge.kind],
      y: (from.y + to.y) / 2 + (dx / length) * offsets[edge.kind],
    };
    ctx.globalAlpha = 0.25 + Math.min(0.4, edge.rate / totalRate);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1 + Math.min(2, (edge.rate / totalRate) * 8);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.quadraticCurveTo(control.x, control.y, to.x, to.y);
    ctx.stroke();

    const t = 0.65;
    const oneMinusT = 1 - t;
    const point = {
      x: oneMinusT * oneMinusT * from.x + 2 * oneMinusT * t * control.x + t * t * to.x,
      y: oneMinusT * oneMinusT * from.y + 2 * oneMinusT * t * control.y + t * t * to.y,
    };
    const tangent = {
      x: 2 * oneMinusT * (control.x - from.x) + 2 * t * (to.x - control.x),
      y: 2 * oneMinusT * (control.y - from.y) + 2 * t * (to.y - control.y),
    };
    const angle = Math.atan2(tangent.y, tangent.x);
    const arrowSize = 4;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(point.x, point.y);
    ctx.lineTo(
      point.x - Math.cos(angle - Math.PI / 6) * arrowSize,
      point.y - Math.sin(angle - Math.PI / 6) * arrowSize,
    );
    ctx.lineTo(
      point.x - Math.cos(angle + Math.PI / 6) * arrowSize,
      point.y - Math.sin(angle + Math.PI / 6) * arrowSize,
    );
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawParticle(ctx: CanvasRenderingContext2D, particle: Particle, edge: FlowEdge): void {
  if (!snapshot) return;
  const located = particlePosition(particle, edge);
  if (!located || located.alpha <= 0) return;
  const color = particleColor(particle.kind, snapshot.palette);
  ctx.globalAlpha = located.alpha;
  const cached = particle.kind === "cache-read" || particle.kind === "cache-write";
  ctx.beginPath();
  ctx.arc(located.point.x, located.point.y, cached ? 2.8 : 2.5, 0, TAU);
  if (cached) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.stroke();
    if (particle.kind === "cache-write") {
      ctx.beginPath();
      ctx.arc(located.point.x, located.point.y, 1, 0, TAU);
      ctx.fillStyle = color;
      ctx.fill();
    }
  } else {
    ctx.fillStyle = color;
    ctx.fill();
  }
}

function drawLabelText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  color: string,
  surface: string,
): void {
  ctx.lineJoin = "round";
  ctx.lineWidth = 4;
  ctx.strokeStyle = surface;
  ctx.strokeText(text, x, y, maxWidth);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y, maxWidth);
}

interface LabelSimulationNode extends SimulationNodeDatum {
  kind: "label" | "obstacle";
  source?: PositionedNode;
  targetX: number;
  targetY: number;
  width: number;
  height: number;
  radius: number;
}

function layoutLabels(ctx: CanvasRenderingContext2D): void {
  if (!labelsDirty || !snapshot) return;
  labelsDirty = false;
  const { palette } = snapshot;
  const margin = 10;
  const secondaryStep = palette.detailFontSize + 2;
  const labels: Array<LabelSimulationNode> = [];

  for (const node of positioned.values()) {
    ctx.font = `${palette.labelFontWeight} ${palette.labelFontSize}px ${palette.fontFamily}`;
    const titleWidth = ctx.measureText(node.label).width;
    ctx.font = `${palette.detailFontSize}px ${palette.fontFamily}`;
    const detailWidth = node.detail ? ctx.measureText(node.detail).width : 0;
    const shareWidth = ctx.measureText(`${Math.round(node.share * 100)}%`).width;
    const labelWidth = Math.max(titleWidth, detailWidth, shareWidth) + 8;
    const labelHeight = palette.labelFontSize + secondaryStep * (node.detail ? 2 : 1);
    const ringScale = Math.min(width, height);
    const outerRadiusX = Math.max(80, ringScale * 0.44);
    const outerRadiusY = outerRadiusX;
    const targetX = width / 2 + Math.cos(node.angle) * outerRadiusX;
    const targetY = height / 2 + Math.sin(node.angle) * outerRadiusY;
    labels.push({
      kind: "label",
      source: node,
      targetX,
      targetY,
      x: targetX,
      y: targetY,
      width: labelWidth,
      height: labelHeight,
      radius: Math.hypot(labelWidth, labelHeight) / 2 + 5,
    });
  }

  const obstacles: Array<LabelSimulationNode> = [...positioned.values()].map((node) => ({
    kind: "obstacle",
    targetX: node.x,
    targetY: node.y,
    x: node.x,
    y: node.y,
    fx: node.x,
    fy: node.y,
    width: 24,
    height: 24,
    radius: 16,
  }));
  ctx.font = `${palette.detailFontSize}px ${palette.fontFamily}`;
  const scaleWidth = ctx.measureText(particleScaleText(snapshot.totalRate, palette)).width + 8;
  const scaleHeight = palette.detailFontSize + 6;
  const scaleX = width - margin - scaleWidth / 2;
  const scaleY = height - margin - scaleHeight / 2;
  obstacles.push({
    kind: "obstacle",
    targetX: scaleX,
    targetY: scaleY,
    x: scaleX,
    y: scaleY,
    fx: scaleX,
    fy: scaleY,
    width: scaleWidth,
    height: scaleHeight,
    radius: Math.hypot(scaleWidth, scaleHeight) / 2 + 4,
  });

  const simulationNodes = [...labels, ...obstacles];
  const simulation = forceSimulation(simulationNodes)
    .force("x", forceX<LabelSimulationNode>((node) => node.targetX).strength(0.75))
    .force("y", forceY<LabelSimulationNode>((node) => node.targetY).strength(0.75))
    .force(
      "collide",
      forceCollide<LabelSimulationNode>((node) => node.radius)
        .strength(1)
        .iterations(4),
    )
    .stop();
  for (let tick = 0; tick < 120; tick++) simulation.tick();

  for (const label of labels) {
    const node = label.source;
    if (!node) continue;
    const x = clamp(label.x ?? label.targetX, margin + label.width / 2, width - margin - label.width / 2);
    const y = clamp(label.y ?? label.targetY, margin + label.height / 2, height - margin - label.height / 2);
    const top = y - label.height / 2;
    node.labelX = x;
    node.labelY = top + palette.labelFontSize / 2;
    node.align = "center";
  }
}

function drawNode(ctx: CanvasRenderingContext2D, node: PositionedNode, palette: FlowPalette): void {
  const selected = snapshot?.selectedSessionId;
  const dim = selected !== null && node.kind === "session" && node.id !== `session:${selected}`;
  ctx.globalAlpha = dim ? 0.3 : 1;
  ctx.strokeStyle =
    node.kind === "model" ? palette.output
    : node.kind === "session" ? palette.input
    : palette.border;
  ctx.fillStyle = palette.surface;
  ctx.lineWidth = 2;
  ctx.beginPath();
  if (node.kind === "tool") {
    ctx.moveTo(node.x, node.y - 7);
    ctx.lineTo(node.x + 7, node.y);
    ctx.lineTo(node.x, node.y + 7);
    ctx.lineTo(node.x - 7, node.y);
    ctx.closePath();
  } else if (node.kind === "session") {
    ctx.roundRect(node.x - 6.5, node.y - 6.5, 13, 13, 3.5);
  } else {
    ctx.arc(node.x, node.y, 7.5, 0, TAU);
  }
  ctx.fill();
  ctx.stroke();
  if (node.kind === "model") {
    ctx.beginPath();
    ctx.arc(node.x, node.y, 2.6, 0, TAU);
    ctx.fillStyle = palette.output;
    ctx.fill();
  }

  ctx.textAlign = node.align;
  ctx.textBaseline = "middle";
  const labelWidth = Math.max(72, width * 0.22);
  const secondaryStep = palette.detailFontSize + 2;
  ctx.font = `${palette.labelFontWeight} ${palette.labelFontSize}px ${palette.fontFamily}`;
  drawLabelText(ctx, node.label, node.labelX, node.labelY, labelWidth, palette.text, palette.surface);
  ctx.font = `${palette.detailFontSize}px ${palette.fontFamily}`;
  if (node.detail) {
    drawLabelText(
      ctx,
      node.detail,
      node.labelX,
      node.labelY + secondaryStep,
      labelWidth,
      palette.muted,
      palette.surface,
    );
  }
  drawLabelText(
    ctx,
    `${Math.round(node.share * 100)}%`,
    node.labelX,
    node.labelY + secondaryStep * (node.detail ? 2 : 1),
    labelWidth,
    palette.muted,
    palette.surface,
  );
}

function drawParticleScale(ctx: CanvasRenderingContext2D, palette: FlowPalette): void {
  if (!snapshot || snapshot.totalRate <= 0) return;
  ctx.globalAlpha = 1;
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  ctx.font = `${palette.detailFontSize}px ${palette.fontFamily}`;
  drawLabelText(
    ctx,
    particleScaleText(snapshot.totalRate, palette),
    width - 10,
    height - 10,
    width / 2,
    palette.muted,
    palette.surface,
  );
}

function draw(): void {
  const ctx = context;
  if (!ctx || !snapshot || width <= 0 || height <= 0) return;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, width, height);
  layoutLabels(ctx);
  if (snapshot.reducedMotion) drawStaticConnections(ctx, snapshot.palette);
  const edgeMap = new Map(snapshot.edges.map((edge) => [edge.id, edge]));
  for (const particle of particles) {
    const edge = edgeMap.get(particle.edgeId);
    if (edge) drawParticle(ctx, particle, edge);
  }
  for (const node of positioned.values()) drawNode(ctx, node, snapshot.palette);
  drawParticleScale(ctx, snapshot.palette);
  ctx.globalAlpha = 1;
}

function tick(now: number): void {
  timer = null;
  const delta = lastFrame === 0 ? FRAME_MS : clamp(now - lastFrame, 0, 100);
  lastFrame = now;
  if (snapshot && !snapshot.reducedMotion && active) {
    reconcileParticles();
    const edges = snapshot.edges.filter(
      (edge) => edge.rate > 0 && positioned.has(edge.from) && positioned.has(edge.to),
    );
    const edgeMap = new Map(edges.map((edge) => [edge.id, edge]));
    for (const particle of particles) {
      particle.age += delta;
      if (particle.age < particle.travelMs + particle.restMs) continue;
      const current = edgeMap.get(particle.edgeId);
      const next = current ? nextEdge(current, edges) : weightedEdge(edges);
      if (next) reverseParticle(particle, next);
    }
    draw();
    if (snapshot.edges.length > 0) timer = setTimeout(() => tick(performance.now()), FRAME_MS);
  } else {
    draw();
  }
}

function schedule(): void {
  if (timer !== null || !active || snapshot?.reducedMotion) return;
  lastFrame = performance.now();
  timer = setTimeout(() => tick(performance.now()), FRAME_MS);
}

function applySnapshot(next: FlowSnapshot): void {
  const first = snapshot === null;
  snapshot = next;
  positioned = positionNodes(next.nodes);
  labelsDirty = true;
  reconcileParticles(first, !first);
  if (next.reducedMotion) {
    for (const particle of particles) particle.age = particle.travelMs + particle.restMs * 0.28;
  }
  draw();
  schedule();
}

globalThis.onmessage = (event: MessageEvent<FlowWorkerMessage>) => {
  const message = event.data;
  if (message.type === "init") {
    active = message.active;
    canvas = message.canvas as WorkerCanvas;
    context = canvas.getContext("2d");
    resize(message.width, message.height, message.scale);
    globalThis.postMessage({ type: "ready" });
    return;
  }
  if (message.type === "resize") {
    resize(message.width, message.height, message.scale);
    return;
  }
  if (message.type === "active") {
    active = message.active;
    if (!active && timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (active) schedule();
    return;
  }
  applySnapshot(message.snapshot);
};
