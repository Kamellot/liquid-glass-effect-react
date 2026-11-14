import {
  DEFAULT_CUSTOM_METRIC_WINDOW_SIZE,
  DEFAULT_MAX_CUSTOM_METRICS,
  DEFAULT_REFRESH_RATE_HZ,
  REFRESH_RATE_SAMPLE_MIN,
  REFRESH_RATE_SNAP_TOLERANCE,
  STANDARD_REFRESH_RATES,
} from './constants'
import type { CustomMetricStats } from './types'

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

export function round2(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(value * 100) / 100
}

/**
 * Nearest-rank percentile (used for P95/P99 frame budget tail analysis) over a pre-sorted array.
 */
export function computePercentile(
  sortedValues: ArrayLike<number>,
  length: number,
  percentile: number,
): number {
  if (length <= 0) return 0
  if (length === 1) return sortedValues[0]
  const clamped = clamp(percentile, 0, 1)
  const rank = Math.ceil(clamped * length)
  const index = clamp(rank - 1, 0, length - 1)
  return sortedValues[index]
}

/**
 * Infers display refresh rate from the fast 15th percentile tail of frame deltas, resisting isolated
 * main-thread spikes, then snaps within 10% to standard display cadence tiers.
 */
export function detectRefreshRateFromSorted(
  sortedFrameTimes: ArrayLike<number>,
  length: number,
  fallbackHz = DEFAULT_REFRESH_RATE_HZ,
): number {
  if (length < REFRESH_RATE_SAMPLE_MIN) return fallbackHz
  const p15Ms = computePercentile(sortedFrameTimes, length, 0.15)
  if (p15Ms <= 0) return fallbackHz

  const rawHz = 1000 / p15Ms
  let nearest: number = STANDARD_REFRESH_RATES[0]
  let bestDiff = Math.abs(rawHz - nearest)

  for (let i = 1; i < STANDARD_REFRESH_RATES.length; i++) {
    const candidate = STANDARD_REFRESH_RATES[i]
    const diff = Math.abs(rawHz - candidate)
    if (diff < bestDiff) {
      bestDiff = diff
      nearest = candidate
    }
  }

  if (bestDiff / nearest <= REFRESH_RATE_SNAP_TOLERANCE) {
    return nearest
  }
  return clamp(Math.round(rawHz), STANDARD_REFRESH_RATES[0], STANDARD_REFRESH_RATES[STANDARD_REFRESH_RATES.length - 1])
}

/**
 * Fixed-capacity ring buffer with a reusable scratch array so sorting for rolling P95/P99
 * frame times allocates zero garbage on the hot animation path.
 */
export class FrameRingBuffer {
  readonly capacity: number
  private readonly buffer: Float64Array
  private readonly scratch: Float64Array
  private head = 0
  private count = 0

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity))
    this.buffer = new Float64Array(this.capacity)
    this.scratch = new Float64Array(this.capacity)
  }

  push(value: number): void {
    this.buffer[this.head] = value
    this.head = (this.head + 1) % this.capacity
    if (this.count < this.capacity) {
      this.count++
    }
  }

  clear(): void {
    this.head = 0
    this.count = 0
  }

  get length(): number {
    return this.count
  }

  getSorted(): Float64Array {
    const n = this.count
    if (n === 0) return this.scratch.subarray(0, 0)

    if (n < this.capacity) {
      this.scratch.set(this.buffer.subarray(0, n))
    } else {
      const firstPart = this.capacity - this.head
      this.scratch.set(this.buffer.subarray(this.head, this.capacity), 0)
      if (this.head > 0) {
        this.scratch.set(this.buffer.subarray(0, this.head), firstPart)
      }
    }

    const view = this.scratch.subarray(0, n)
    view.sort()
    return view
  }

  sum(): number {
    let total = 0
    for (let i = 0; i < this.count; i++) {
      total += this.buffer[i]
    }
    return total
  }

  countAbove(threshold: number): number {
    let hits = 0
    for (let i = 0; i < this.count; i++) {
      if (this.buffer[i] > threshold) hits++
    }
    return hits
  }
}

interface CustomMetricBucket {
  count: number
  totalMs: number
  minMs: number
  maxMs: number
  lastMs: number
  ring: FrameRingBuffer
}

export class CustomMetricTracker {
  private readonly buckets = new Map<string, CustomMetricBucket>()
  private readonly maxMetrics: number
  private readonly windowSize: number

  constructor(
    maxMetrics = DEFAULT_MAX_CUSTOM_METRICS,
    windowSize = DEFAULT_CUSTOM_METRIC_WINDOW_SIZE,
  ) {
    this.maxMetrics = Math.max(1, maxMetrics)
    this.windowSize = Math.max(1, windowSize)
  }

  record(name: string, durationMs: number): boolean {
    if (!name || !Number.isFinite(durationMs)) return false
    const safeDuration = Math.max(0, durationMs)

    let bucket = this.buckets.get(name)
    if (!bucket) {
      if (this.buckets.size >= this.maxMetrics) return false
      bucket = {
        count: 0,
        totalMs: 0,
        minMs: safeDuration,
        maxMs: safeDuration,
        lastMs: safeDuration,
        ring: new FrameRingBuffer(this.windowSize),
      }
      this.buckets.set(name, bucket)
    }

    bucket.count += 1
    bucket.totalMs += safeDuration
    if (safeDuration < bucket.minMs) bucket.minMs = safeDuration
    if (safeDuration > bucket.maxMs) bucket.maxMs = safeDuration
    bucket.lastMs = safeDuration
    bucket.ring.push(safeDuration)
    return true
  }

  clear(): void {
    this.buckets.clear()
  }

  toRecord(): Record<string, CustomMetricStats> {
    const out: Record<string, CustomMetricStats> = {}
    for (const [name, bucket] of this.buckets) {
      const sorted = bucket.ring.getSorted()
      const p95Ms = computePercentile(sorted, sorted.length, 0.95)
      out[name] = {
        name,
        count: bucket.count,
        totalMs: round2(bucket.totalMs),
        avgMs: round2(bucket.totalMs / bucket.count),
        minMs: round2(bucket.minMs),
        maxMs: round2(bucket.maxMs),
        lastMs: round2(bucket.lastMs),
        p95Ms: round2(p95Ms),
      }
    }
    return out
  }
}
