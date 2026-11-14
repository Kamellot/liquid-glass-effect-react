import {
  BYTES_PER_MB,
  DEFAULT_CUSTOM_METRIC_WINDOW_SIZE,
  DEFAULT_EMIT_INTERVAL_MS,
  DEFAULT_JANK_TOLERANCE_RATIO,
  DEFAULT_MAX_CUSTOM_METRICS,
  DEFAULT_MAX_FRAME_GAP_MS,
  DEFAULT_MAX_OPEN_MARKS,
  DEFAULT_MAX_OPEN_MARKS_PER_NAME,
  DEFAULT_REFRESH_RATE_HZ,
  DEFAULT_WINDOW_SIZE,
  LONG_TASK_THRESHOLD_MS,
  REFRESH_RATE_RESAMPLE_INTERVAL,
  REFRESH_RATE_SAMPLE_MIN,
} from './constants'
import {
  CustomMetricTracker,
  FrameRingBuffer,
  computePercentile,
  detectRefreshRateFromSorted,
  round2,
} from './stats'
import type {
  DeviceHints,
  DeviceTierHint,
  MemoryMetrics,
  PerfEngineLike,
  PerfEngineOptions,
  PerfEvent,
  PerfSnapshot,
} from './types'

interface PerformanceWithMemory extends Performance {
  memory?: {
    usedJSHeapSize?: number
    totalJSHeapSize?: number
    jsHeapSizeLimit?: number
  }
}

interface NavigatorWithDeviceMemory extends Navigator {
  deviceMemory?: number
}

const EMPTY_MEMORY: MemoryMetrics = {
  usedJSHeapSizeMb: null,
  totalJSHeapSizeMb: null,
  jsHeapSizeLimitMb: null,
}

const SSR_DEVICE_HINTS: DeviceHints = {
  hardwareConcurrency: null,
  deviceMemoryGb: null,
  prefersReducedMotion: false,
  devicePixelRatio: 1,
  userAgent: 'unknown',
  estimatedTier: 'high',
}

function buildStaticSnapshot(
  refreshRateHz: number,
  jankToleranceRatio: number,
): PerfSnapshot {
  const frameBudgetMs = 1000 / refreshRateHz
  return {
    isRunning: false,
    timestamp: 0,
    fps: 0,
    avgFrameTime: 0,
    p95FrameTime: 0,
    p99FrameTime: 0,
    minFrameTime: 0,
    maxFrameTime: 0,
    refreshRateHz,
    frameBudgetMs: round2(frameBudgetMs),
    jankThresholdMs: round2(frameBudgetMs * jankToleranceRatio),
    droppedFrames: 0,
    severeJankFrames: 0,
    jankPercent: 0,
    windowFrames: 0,
    totalFrames: 0,
    longTaskCount: 0,
    totalBlockingTimeMs: 0,
    maxLongTaskMs: 0,
    longTaskSupported: false,
    jsHeapUsedMb: null,
    memory: EMPTY_MEMORY,
    deviceHints: SSR_DEVICE_HINTS,
    customMetrics: {},
  }
}

function defaultNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}

function readMemoryMetrics(): MemoryMetrics {
  if (typeof performance === 'undefined') return EMPTY_MEMORY
  const mem = (performance as PerformanceWithMemory).memory
  if (!mem) return EMPTY_MEMORY

  const toMb = (bytes: unknown): number | null =>
    typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0
      ? round2(bytes / BYTES_PER_MB)
      : null

  return {
    usedJSHeapSizeMb: toMb(mem.usedJSHeapSize),
    totalJSHeapSizeMb: toMb(mem.totalJSHeapSize),
    jsHeapSizeLimitMb: toMb(mem.jsHeapSizeLimit),
  }
}

function deriveEstimatedTier(
  hardwareConcurrency: number | null,
  deviceMemoryGb: number | null,
): DeviceTierHint {
  if (
    (deviceMemoryGb !== null && deviceMemoryGb <= 2) ||
    (hardwareConcurrency !== null && hardwareConcurrency <= 2)
  ) {
    return 'low'
  }
  if (
    (deviceMemoryGb !== null && deviceMemoryGb <= 4) ||
    (hardwareConcurrency !== null && hardwareConcurrency <= 4)
  ) {
    return 'mid'
  }
  return 'high'
}

function readDeviceHints(): DeviceHints {
  const hardwareConcurrency =
    typeof navigator !== 'undefined' &&
    typeof navigator.hardwareConcurrency === 'number' &&
    Number.isFinite(navigator.hardwareConcurrency)
      ? navigator.hardwareConcurrency
      : null

  const rawDeviceMemory =
    typeof navigator !== 'undefined'
      ? (navigator as NavigatorWithDeviceMemory).deviceMemory
      : undefined
  const deviceMemoryGb =
    typeof rawDeviceMemory === 'number' && Number.isFinite(rawDeviceMemory)
      ? rawDeviceMemory
      : null

  const prefersReducedMotion =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false

  const devicePixelRatio =
    typeof window !== 'undefined' &&
    typeof window.devicePixelRatio === 'number' &&
    Number.isFinite(window.devicePixelRatio) &&
    window.devicePixelRatio > 0
      ? window.devicePixelRatio
      : 1

  const userAgent =
    typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string'
      ? navigator.userAgent
      : 'unknown'

  return {
    hardwareConcurrency,
    deviceMemoryGb,
    prefersReducedMotion,
    devicePixelRatio,
    userAgent,
    estimatedTier: deriveEstimatedTier(hardwareConcurrency, deviceMemoryGb),
  }
}

function supportsLongTaskObserver(): boolean {
  if (typeof PerformanceObserver === 'undefined') return false
  const supported = (PerformanceObserver as { supportedEntryTypes?: readonly string[] })
    .supportedEntryTypes
  if (Array.isArray(supported)) {
    return supported.includes('longtask')
  }
  return true
}

export class PerfEngine implements PerfEngineLike {
  private readonly ring: FrameRingBuffer
  private readonly customTracker: CustomMetricTracker
  private readonly emitIntervalMs: number
  private readonly fixedRefreshRateHz: number | null
  private readonly jankToleranceRatio: number
  private readonly maxFrameGapMs: number
  private readonly customClock: (() => number) | null
  private readonly customRequestFrame: ((cb: (ts: number) => void) => number) | null
  private readonly customCancelFrame: ((handle: number) => void) | null

  private readonly snapshotListeners = new Set<() => void>()
  private readonly eventListeners = new Set<(event: PerfEvent) => void>()
  private readonly openMarks = new Map<string, number[]>()

  private manualRunning = false
  private activeAcquires = 0
  private running = false
  private rafHandle: number | null = null
  private lastFrameTimestamp: number | null = null
  private lastEmitTimestamp: number | null = null

  private detectedRefreshRateHz: number
  private totalFrames = 0
  private droppedFrames = 0
  private severeJankFrames = 0

  private longTaskObserver: PerformanceObserver | null = null
  private longTaskCount = 0
  private totalBlockingTimeMs = 0
  private maxLongTaskMs = 0

  private visibilityCleanup: (() => void) | null = null
  private reducedMotionCleanup: (() => void) | null = null

  private readonly serverSnapshot: PerfSnapshot
  private cachedSnapshot: PerfSnapshot

  constructor(options: PerfEngineOptions = {}) {
    // Constructor stays free of browser global reads so importing perfMonitor is SSR-safe.
    const windowSize = options.windowSize ?? DEFAULT_WINDOW_SIZE
    this.ring = new FrameRingBuffer(windowSize)
    this.customTracker = new CustomMetricTracker(
      options.maxCustomMetrics ?? DEFAULT_MAX_CUSTOM_METRICS,
      options.customMetricWindowSize ?? DEFAULT_CUSTOM_METRIC_WINDOW_SIZE,
    )
    this.emitIntervalMs = Math.max(0, options.emitIntervalMs ?? DEFAULT_EMIT_INTERVAL_MS)
    this.fixedRefreshRateHz =
      typeof options.targetRefreshRateHz === 'number' &&
      Number.isFinite(options.targetRefreshRateHz) &&
      options.targetRefreshRateHz > 0
        ? options.targetRefreshRateHz
        : null
    this.jankToleranceRatio =
      typeof options.jankToleranceRatio === 'number' &&
      Number.isFinite(options.jankToleranceRatio) &&
      options.jankToleranceRatio >= 1
        ? options.jankToleranceRatio
        : DEFAULT_JANK_TOLERANCE_RATIO
    this.maxFrameGapMs =
      typeof options.maxFrameGapMs === 'number' &&
      Number.isFinite(options.maxFrameGapMs) &&
      options.maxFrameGapMs > 0
        ? options.maxFrameGapMs
        : DEFAULT_MAX_FRAME_GAP_MS

    this.customClock = options.now ?? null
    this.customRequestFrame = options.requestFrame ?? null
    this.customCancelFrame = options.cancelFrame ?? null

    this.detectedRefreshRateHz = this.fixedRefreshRateHz ?? DEFAULT_REFRESH_RATE_HZ
    this.serverSnapshot = buildStaticSnapshot(
      this.detectedRefreshRateHz,
      this.jankToleranceRatio,
    )
    this.cachedSnapshot = this.serverSnapshot
  }

  now(): number {
    return this.customClock ? this.customClock() : defaultNow()
  }

  isRunning(): boolean {
    return this.running
  }

  acquire(): () => void {
    let released = false
    this.activeAcquires += 1
    this.syncRunningState()
    return () => {
      if (released) return
      released = true
      this.activeAcquires = Math.max(0, this.activeAcquires - 1)
      this.syncRunningState()
    }
  }

  start(): void {
    this.manualRunning = true
    this.syncRunningState()
  }

  stop(): void {
    this.manualRunning = false
    this.syncRunningState()
  }

  reset(): void {
    const timestamp = this.now()
    this.ring.clear()
    this.customTracker.clear()
    this.openMarks.clear()

    this.totalFrames = 0
    this.droppedFrames = 0
    this.severeJankFrames = 0
    this.longTaskCount = 0
    this.totalBlockingTimeMs = 0
    this.maxLongTaskMs = 0
    this.lastFrameTimestamp = null
    this.lastEmitTimestamp = null
    this.detectedRefreshRateHz = this.fixedRefreshRateHz ?? DEFAULT_REFRESH_RATE_HZ

    this.emitEvent({ type: 'reset', timestamp })
    this.rebuildAndNotify(timestamp)
  }

  flush(): PerfSnapshot {
    this.rebuildAndNotify(this.now())
    return this.cachedSnapshot
  }

  getSnapshot(): PerfSnapshot {
    return this.cachedSnapshot
  }

  getServerSnapshot(): PerfSnapshot {
    return this.serverSnapshot
  }

  getMetrics(): PerfSnapshot {
    return this.cachedSnapshot
  }

  subscribe(listener: () => void): () => void {
    this.snapshotListeners.add(listener)
    return () => {
      this.snapshotListeners.delete(listener)
    }
  }

  onEvent(listener: (event: PerfEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  markStart(name: string): void {
    if (!name) return
    let stack = this.openMarks.get(name)
    if (!stack) {
      if (this.openMarks.size >= DEFAULT_MAX_OPEN_MARKS) return
      stack = []
      this.openMarks.set(name, stack)
    }
    if (stack.length >= DEFAULT_MAX_OPEN_MARKS_PER_NAME) {
      stack.shift()
    }
    stack.push(this.now())
  }

  markEnd(name: string): number | null {
    if (!name) return null
    const stack = this.openMarks.get(name)
    if (!stack || stack.length === 0) return null
    const startTs = stack.pop()!
    if (stack.length === 0) {
      this.openMarks.delete(name)
    }
    const durationMs = Math.max(0, this.now() - startTs)
    this.recordMetric(name, durationMs)
    return durationMs
  }

  recordDuration(name: string, durationMs: number): void {
    this.recordMetric(name, durationMs)
  }

  recordMetric(name: string, durationMs: number): void {
    const recorded = this.customTracker.record(name, durationMs)
    if (!recorded) return

    const timestamp = this.now()
    this.emitEvent({
      type: 'metric',
      timestamp,
      name,
      durationMs: Math.max(0, durationMs),
    })

    if (
      !this.running ||
      !this.hasFrameScheduler() ||
      this.emitIntervalMs === 0 ||
      this.lastEmitTimestamp === null ||
      timestamp - this.lastEmitTimestamp >= this.emitIntervalMs
    ) {
      this.lastEmitTimestamp = timestamp
      this.rebuildAndNotify(timestamp)
    }
  }

  measure<T>(name: string, fn: () => T): T {
    this.markStart(name)
    try {
      return fn()
    } finally {
      this.markEnd(name)
    }
  }

  private hasFrameScheduler(): boolean {
    return (
      this.customRequestFrame !== null ||
      (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function')
    )
  }

  private requestFrame(cb: (ts: number) => void): number | null {
    if (this.customRequestFrame) return this.customRequestFrame(cb)
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      return window.requestAnimationFrame(cb)
    }
    return null
  }

  private cancelFrame(handle: number): void {
    if (this.customCancelFrame) {
      this.customCancelFrame(handle)
      return
    }
    if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(handle)
    }
  }

  private syncRunningState(): void {
    const shouldRun = this.manualRunning || this.activeAcquires > 0
    if (shouldRun && !this.running) {
      this.beginObservation()
    } else if (!shouldRun && this.running) {
      this.endObservation()
    }
  }

  private beginObservation(): void {
    this.running = true
    this.lastFrameTimestamp = null
    this.lastEmitTimestamp = null

    this.attachLongTaskObserver()
    this.attachEnvironmentListeners()
    this.scheduleNextFrame()
    this.rebuildAndNotify(this.now())
  }

  private endObservation(): void {
    this.running = false
    this.lastFrameTimestamp = null

    if (this.rafHandle !== null) {
      this.cancelFrame(this.rafHandle)
      this.rafHandle = null
    }

    this.detachLongTaskObserver()
    this.detachEnvironmentListeners()
    this.rebuildAndNotify(this.now())
  }

  private scheduleNextFrame(): void {
    if (!this.running) return
    this.rafHandle = this.requestFrame(this.handleAnimationFrame)
  }

  private readonly handleAnimationFrame = (timestamp: number): void => {
    this.rafHandle = null
    if (!this.running) return

    if (this.lastFrameTimestamp === null) {
      this.lastFrameTimestamp = timestamp
      this.scheduleNextFrame()
      return
    }

    const deltaMs = timestamp - this.lastFrameTimestamp
    this.lastFrameTimestamp = timestamp

    if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
      this.scheduleNextFrame()
      return
    }

    // Discard backgrounded-tab or sleep gaps so resume spikes do not poison rolling P95/P99.
    if (deltaMs > this.maxFrameGapMs) {
      this.scheduleNextFrame()
      return
    }

    this.ring.push(deltaMs)
    this.totalFrames += 1

    if (
      this.fixedRefreshRateHz === null &&
      this.ring.length >= REFRESH_RATE_SAMPLE_MIN &&
      (this.totalFrames === REFRESH_RATE_SAMPLE_MIN ||
        this.totalFrames % REFRESH_RATE_RESAMPLE_INTERVAL === 0)
    ) {
      const sorted = this.ring.getSorted()
      this.detectedRefreshRateHz = detectRefreshRateFromSorted(
        sorted,
        this.ring.length,
        this.detectedRefreshRateHz,
      )
    }

    const frameBudgetMs = 1000 / this.detectedRefreshRateHz
    const jankThresholdMs = frameBudgetMs * this.jankToleranceRatio
    const severeThresholdMs = frameBudgetMs * 2

    const dropped = deltaMs > jankThresholdMs
    const severe = deltaMs > severeThresholdMs

    if (dropped) this.droppedFrames += 1
    if (severe) this.severeJankFrames += 1

    this.emitEvent({ type: 'frame', timestamp, deltaMs, dropped, severe })

    if (
      this.totalFrames === 1 ||
      this.lastEmitTimestamp === null ||
      timestamp - this.lastEmitTimestamp >= this.emitIntervalMs
    ) {
      this.lastEmitTimestamp = timestamp
      this.rebuildAndNotify(timestamp)
    }

    this.scheduleNextFrame()
  }

  private attachLongTaskObserver(): void {
    if (!supportsLongTaskObserver() || this.longTaskObserver) return
    try {
      const observer = new PerformanceObserver((list) => {
        const entries = list.getEntries()
        const nowTs = this.now()
        let updated = false

        for (let i = 0; i < entries.length; i++) {
          const durationMs = entries[i].duration
          if (!Number.isFinite(durationMs) || durationMs <= LONG_TASK_THRESHOLD_MS) {
            continue
          }
          const blockingTimeMs = durationMs - LONG_TASK_THRESHOLD_MS
          this.longTaskCount += 1
          this.totalBlockingTimeMs += blockingTimeMs
          if (durationMs > this.maxLongTaskMs) {
            this.maxLongTaskMs = durationMs
          }
          updated = true
          this.emitEvent({
            type: 'longtask',
            timestamp: nowTs,
            durationMs,
            blockingTimeMs,
          })
        }

        if (
          updated &&
          (this.lastEmitTimestamp === null ||
            nowTs - this.lastEmitTimestamp >= this.emitIntervalMs)
        ) {
          this.lastEmitTimestamp = nowTs
          this.rebuildAndNotify(nowTs)
        }
      })
      observer.observe({ entryTypes: ['longtask'] })
      this.longTaskObserver = observer
    } catch {
      this.longTaskObserver = null
    }
  }

  private detachLongTaskObserver(): void {
    if (!this.longTaskObserver) return
    try {
      this.longTaskObserver.disconnect()
    } catch {
      // Ignore teardown failures in restricted runtimes.
    }
    this.longTaskObserver = null
  }

  private attachEnvironmentListeners(): void {
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      const onVisibilityChange = () => {
        if (document.visibilityState === 'hidden') {
          this.lastFrameTimestamp = null
        }
      }
      document.addEventListener('visibilitychange', onVisibilityChange)
      this.visibilityCleanup = () => {
        document.removeEventListener('visibilitychange', onVisibilityChange)
      }
    }

    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      const mql = window.matchMedia('(prefers-reduced-motion: reduce)')
      const onMotionChange = () => {
        this.rebuildAndNotify(this.now())
      }
      if (typeof mql.addEventListener === 'function') {
        mql.addEventListener('change', onMotionChange)
        this.reducedMotionCleanup = () => mql.removeEventListener('change', onMotionChange)
      } else if (typeof mql.addListener === 'function') {
        mql.addListener(onMotionChange)
        this.reducedMotionCleanup = () => mql.removeListener(onMotionChange)
      }
    }
  }

  private detachEnvironmentListeners(): void {
    this.visibilityCleanup?.()
    this.visibilityCleanup = null
    this.reducedMotionCleanup?.()
    this.reducedMotionCleanup = null
  }

  private emitEvent(event: PerfEvent): void {
    for (const listener of this.eventListeners) {
      listener(event)
    }
  }

  private rebuildAndNotify(timestamp: number): void {
    this.cachedSnapshot = this.buildSnapshot(timestamp)
    for (const listener of this.snapshotListeners) {
      listener()
    }
  }

  private buildSnapshot(timestamp: number): PerfSnapshot {
    const windowFrames = this.ring.length
    const sorted = this.ring.getSorted()

    if (this.fixedRefreshRateHz !== null) {
      this.detectedRefreshRateHz = this.fixedRefreshRateHz
    } else if (windowFrames >= REFRESH_RATE_SAMPLE_MIN) {
      this.detectedRefreshRateHz = detectRefreshRateFromSorted(
        sorted,
        windowFrames,
        DEFAULT_REFRESH_RATE_HZ,
      )
    }

    const refreshRateHz = this.detectedRefreshRateHz
    const frameBudgetMs = 1000 / refreshRateHz
    const jankThresholdMs = frameBudgetMs * this.jankToleranceRatio

    const avgFrameTime = windowFrames > 0 ? this.ring.sum() / windowFrames : 0
    const fps = avgFrameTime > 0 ? 1000 / avgFrameTime : 0
    const p95FrameTime = computePercentile(sorted, windowFrames, 0.95)
    const p99FrameTime = computePercentile(sorted, windowFrames, 0.99)
    const minFrameTime = windowFrames > 0 ? sorted[0] : 0
    const maxFrameTime = windowFrames > 0 ? sorted[windowFrames - 1] : 0

    const windowDropped = windowFrames > 0 ? this.ring.countAbove(jankThresholdMs) : 0
    const jankPercent = windowFrames > 0 ? (windowDropped / windowFrames) * 100 : 0

    const memory = readMemoryMetrics()
    const deviceHints = readDeviceHints()

    return {
      isRunning: this.running,
      timestamp: round2(timestamp),
      fps: round2(fps),
      avgFrameTime: round2(avgFrameTime),
      p95FrameTime: round2(p95FrameTime),
      p99FrameTime: round2(p99FrameTime),
      minFrameTime: round2(minFrameTime),
      maxFrameTime: round2(maxFrameTime),
      refreshRateHz,
      frameBudgetMs: round2(frameBudgetMs),
      jankThresholdMs: round2(jankThresholdMs),
      droppedFrames: this.droppedFrames,
      severeJankFrames: this.severeJankFrames,
      jankPercent: round2(jankPercent),
      windowFrames,
      totalFrames: this.totalFrames,
      longTaskCount: this.longTaskCount,
      totalBlockingTimeMs: round2(this.totalBlockingTimeMs),
      maxLongTaskMs: round2(this.maxLongTaskMs),
      longTaskSupported: supportsLongTaskObserver(),
      jsHeapUsedMb: memory.usedJSHeapSizeMb,
      memory,
      deviceHints,
      customMetrics: this.customTracker.toRecord(),
    }
  }
}

export const perfMonitor = new PerfEngine()
