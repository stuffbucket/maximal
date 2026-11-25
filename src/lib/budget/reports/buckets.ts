/**
 * Bucket boundaries for the timeline, all UTC: an hour is 3 600 000 ms, a day
 * 86 400 000 ms and a week starts on Monday 00:00 UTC, like the budget
 * periods. Local daylight-saving changes never shift a boundary, so a bucket
 * is always the same length.
 */

import { DAY_MS, startOfUtcDay, startOfUtcWeek } from "../periods"

export const BUCKET_SIZES = ["hour", "day", "week"] as const
export type BucketSize = (typeof BUCKET_SIZES)[number]

export function isBucketSize(value: unknown): value is BucketSize {
  return (BUCKET_SIZES as ReadonlyArray<unknown>).includes(value)
}

const HOUR_MS = 3_600_000

const LENGTH_MS: Record<BucketSize, number> = {
  hour: HOUR_MS,
  day: DAY_MS,
  week: 7 * DAY_MS,
}

/** The start of the bucket that contains `ms`. */
export function bucketStart(size: BucketSize, ms: number): number {
  if (size === "hour") return Math.floor(ms / HOUR_MS) * HOUR_MS
  if (size === "day") return startOfUtcDay(ms)
  return startOfUtcWeek(ms)
}

/** The start of the bucket after the one that starts at `startMs`. */
export function nextBucketStart(size: BucketSize, startMs: number): number {
  return startMs + LENGTH_MS[size]
}

/** Hours for up to two days, days for up to four months, weeks beyond. */
export function defaultBucket(spanMs: number): BucketSize {
  if (spanMs <= 2 * DAY_MS) return "hour"
  if (spanMs <= 120 * DAY_MS) return "day"
  return "week"
}

/** How many buckets of `size` cover `[fromMs, toMs)`. */
export function bucketCount(
  size: BucketSize,
  fromMs: number,
  toMs: number,
): number {
  const first = bucketStart(size, fromMs)
  return Math.max(0, Math.ceil((toMs - first) / LENGTH_MS[size]))
}
