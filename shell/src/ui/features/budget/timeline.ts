/**
 * The geometry and words behind a rule's timeline, free of the DOM and the
 * catalog so they can be tested on their own (tests/budget-timeline.test.ts).
 * Positions are fractions: x runs 0 to 1 across the range, y 0 to 1 up from
 * the baseline, so the chart can draw them at any size.
 */

import type { BudgetTimelineResponse } from "../../../../../src/lib/config/settings-types";

import { type RangeChoice, rangeParams } from "./range";

export type Timeline = BudgetTimelineResponse;
export type MarkerKind = Timeline["markers"][number]["kind"];

/** One period's run of cumulative spend, as points left to right. */
export interface ChartRun {
  periodStart: string;
  points: Array<[x: number, y: number]>;
}

export interface ChartMarker {
  kind: MarkerKind;
  x: number;
  y: number;
  at: string;
  /** Refused requests the marker stands for; 1 for the others. */
  count: number;
  /** What the refused requests would have cost, in nano-AIU. */
  estimateNanoAiu: number;
}

/** One bucket's spend as a column. */
export interface ChartColumn {
  start: string;
  x0: number;
  x1: number;
  /** 0 to 1 of the busiest bucket. */
  height: number;
  nanoAiu: number;
  refused: number;
}

export interface ChartModel {
  runs: Array<ChartRun>;
  limitY: number;
  warnY: number;
  /** Where a new period begins, inside the range. */
  boundaries: Array<number>;
  markers: Array<ChartMarker>;
  columns: Array<ChartColumn>;
  /** Index of the busiest column, or -1 when nothing was spent. */
  busiest: number;
  /** The most the rule's counted spend reached in one period, nano-AIU. */
  peakNanoAiu: number;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** The request path for a rule's timeline, or null while a custom range is incomplete. */
export function timelinePath(id: string, choice: RangeChoice): `/settings/api/budget/limits/${string}/timeline?${string}` | null {
  const range = rangeParams(choice);
  if (!range) return null;
  return `/settings/api/budget/limits/${encodeURIComponent(id)}/timeline?${new URLSearchParams(range).toString()}`;
}

/**
 * Lay a timeline out: cumulative spend per period (it starts over where a period
 * resets, so each period is its own run), the limit and warning lines, the
 * boundaries between periods, the markers on the line they belong to (warned on
 * the warning line, crossed and refused on the limit), and a column per bucket.
 */
export function chartModel(timeline: Timeline): ChartModel {
  const fromMs = Date.parse(timeline.range.from);
  const toMs = Date.parse(timeline.range.to);
  const span = toMs > fromMs ? toMs - fromMs : 1;
  const x = (iso: string): number => clamp01((Date.parse(iso) - fromMs) / span);
  const peakNanoAiu = timeline.buckets.reduce((peak, bucket) => Math.max(peak, bucket.cumulative_nano_aiu), 0);
  const top = Math.max(timeline.limit.limit * 1.1, peakNanoAiu * 1.05, 1);
  const y = (nanoAiu: number): number => clamp01(nanoAiu / top);

  const runs: Array<ChartRun> = [];
  for (const bucket of timeline.buckets) {
    let run = runs.at(-1);
    if (run?.periodStart !== bucket.period_start) {
      run = { periodStart: bucket.period_start, points: [] };
      runs.push(run);
      // A run begins where the bucket began, at what the period had spent before it.
      run.points.push([x(bucket.start), y(bucket.cumulative_nano_aiu - bucket.nano_aiu)]);
    }
    run.points.push([x(bucket.end), y(bucket.cumulative_nano_aiu)]);
  }

  const peakBucket = timeline.buckets.reduce((peak, bucket) => Math.max(peak, bucket.nano_aiu), 0);
  const columns = timeline.buckets.map((bucket) => ({
    start: bucket.start,
    x0: x(bucket.start),
    x1: x(bucket.end),
    height: peakBucket > 0 ? bucket.nano_aiu / peakBucket : 0,
    nanoAiu: bucket.nano_aiu,
    refused: bucket.refused,
  }));
  const tallest = Math.max(0, ...columns.map((column) => column.height));
  const limitY = y(timeline.limit.limit);
  const warnY = y(timeline.limit.warn_line);

  return {
    runs,
    limitY,
    warnY,
    boundaries: timeline.periods
      .map((period) => x(period.start))
      .filter((position) => position > 0 && position < 1),
    markers: timeline.markers.map((marker) => ({
      kind: marker.kind,
      x: x(marker.at),
      y: marker.kind === "warned" ? warnY : limitY,
      at: marker.at,
      count: marker.kind === "refused" ? (marker.count ?? 1) : 1,
      estimateNanoAiu: marker.estimate_nano_aiu ?? 0,
    })),
    columns,
    busiest: tallest > 0 ? columns.findIndex((column) => column.height === tallest) : -1,
    peakNanoAiu,
  };
}

/** How many times each kind of marker occurred (refused counts requests, not buckets). */
export function markerCounts(timeline: Timeline): Record<MarkerKind, number> {
  const counts: Record<MarkerKind, number> = { warned: 0, crossed: 0, refused: 0 };
  for (const marker of timeline.markers) {
    counts[marker.kind] += marker.kind === "refused" ? (marker.count ?? 1) : 1;
  }
  return counts;
}

/** The spend per bucket, as 0 to 1 of the busiest, for a row's sparkline. */
export function sparkValues(timeline: Timeline): Array<number> {
  const peak = timeline.buckets.reduce((max, bucket) => Math.max(max, bucket.nano_aiu), 0);
  return timeline.buckets.map((bucket) => (peak > 0 ? bucket.nano_aiu / peak : 0));
}

/** The sparkline's polyline points in a 100 by 24 box (y down), oldest left. */
export function sparkPoints(values: ReadonlyArray<number>, width = 100, height = 24): string {
  if (values.length === 0) return "";
  const pad = 2;
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  return values
    .map((value, index) => `${(index * step).toFixed(2)},${(height - pad - value * (height - 2 * pad)).toFixed(2)}`)
    .join(" ");
}

export interface PeriodRow {
  start: string;
  end: string | null;
  estimated: boolean;
  spendNanoAiu: number;
  warnedAt: string | null;
  crossedAt: string | null;
  refused: number;
}

/** The periods newest first, which is the order a person reads a history in. */
export function periodRows(timeline: Timeline): Array<PeriodRow> {
  return [...timeline.periods]
    .sort((a, b) => Date.parse(b.start) - Date.parse(a.start))
    .map((period) => ({
      start: period.start,
      end: period.end,
      estimated: period.estimated,
      spendNanoAiu: period.spend_nano_aiu,
      warnedAt: period.warned_at,
      crossedAt: period.crossed_at,
      refused: period.refused,
    }));
}

/** Whether anything counted against the rule in the range: spend, or a refusal. */
export function timelineHasActivity(timeline: Timeline): boolean {
  return timeline.totals.nano_aiu > 0 || timeline.totals.requests > 0 || timeline.totals.refused > 0;
}
