export type DeviceTierHint = 'low' | 'mid' | 'high'

export interface DeviceHints {
  /** Logical CPU cores reported by navigator.hardwareConcurrency, or null if unavailable. */
  hardwareConcurrency: number | null
  /** Approximate device RAM in GB when exposed by navigator.deviceMemory; null in SSR or unsupported browsers. */
  deviceMemoryGb: number | null
  /** Whether the user/OS prefers reduced motion. */
  prefersReducedMotion: boolean
  /** Current display devicePixelRatio (defaults to 1 in SSR). */
  devicePixelRatio: number
  /** Browser user agent string (or 'unknown' in SSR). */
  userAgent: string
  /** Coarse hardware capability estimate derived from concurrency and memory hints. */
  estimatedTier: DeviceTierHint
}

export interface MemoryMetrics {
  /** Current used JS heap size in MB when Performance.memory is exposed; null in SSR or unsupported browsers. */
  usedJSHeapSizeMb: number | null
  /** Total allocated JS heap size in MB when exposed; null elsewhere. */
  totalJSHeapSizeMb: number | null
  /** JS heap size limit in MB when exposed; null elsewhere. */
  jsHeapSizeLimitMb: number | null
}

export interface CustomMetricStats {
  name: string
  count: number
  totalMs: number
  avgMs: number
  minMs: number
  maxMs: number
  lastMs: number
  p95Ms: number
}

export interface PerfSnapshot {
  /** Whether the telemetry loop is currently running. */
  isRunning: boolean
  /** High-resolution timestamp when this snapshot was built. */
  timestamp: number
  /** Rolling average frames per second over the frame window. */
  fps: number
  /** Rolling arithmetic mean frame time in milliseconds. */
  avgFrameTime: number
  /** 95th percentile frame time in milliseconds over the rolling window. */
  p95FrameTime: number
  /** 99th percentile frame time in milliseconds over the rolling window. */
  p99FrameTime: number
  /** Minimum frame time in milliseconds in the rolling window. */
  minFrameTime: number
  /** Maximum frame time in milliseconds in the rolling window. */
  maxFrameTime: number
  /** Auto-detected (or explicitly configured) display refresh rate in Hz. */
  refreshRateHz: number
  /** Target frame budget in milliseconds (1000 / refreshRateHz). */
  frameBudgetMs: number
  /** Frame duration threshold (ms) above which a frame counts as dropped/jank. */
  jankThresholdMs: number
  /** Cumulative count of frames exceeding jankThresholdMs since start/reset. */
  droppedFrames: number
  /** Cumulative count of frames exceeding 2x frameBudgetMs (e.g. > 33.3ms at 60Hz). */
  severeJankFrames: number
  /** Percentage of frames in the rolling window exceeding jankThresholdMs (0-100). */
  jankPercent: number
  /** Number of frame samples currently in the rolling window. */
  windowFrames: number
  /** Total valid frames recorded since start/reset. */
  totalFrames: number
  /** Cumulative count of main-thread Long Tasks (> 50ms). */
  longTaskCount: number
  /** Cumulative Total Blocking Time in milliseconds: sum of (duration - 50ms). */
  totalBlockingTimeMs: number
  /** Longest observed Long Task duration in milliseconds. */
  maxLongTaskMs: number
  /** Whether PerformanceObserver('longtask') is supported in this environment. */
  longTaskSupported: boolean
  /** Current used JS heap size in MB when Performance.memory is exposed; null in SSR or unsupported browsers. */
  jsHeapUsedMb: number | null
  /** Detailed JS heap memory snapshot. */
  memory: MemoryMetrics
  /** Device hardware and reduced-motion hints. */
  deviceHints: DeviceHints
  /** Aggregated statistics for external custom marks/durations. */
  customMetrics: Record<string, CustomMetricStats>
}

export type PerfEvent =
  | {
      type: 'frame'
      timestamp: number
      deltaMs: number
      dropped: boolean
      severe: boolean
    }
  | {
      type: 'longtask'
      timestamp: number
      durationMs: number
      blockingTimeMs: number
    }
  | {
      type: 'metric'
      timestamp: number
      name: string
      durationMs: number
    }
  | {
      type: 'reset'
      timestamp: number
    }

export interface PerfEngineOptions {
  /** Number of recent frames tracked in the rolling statistics window. Default: 120. */
  windowSize?: number
  /** Minimum interval (ms) between subscriber snapshot emissions while running. Default: 250. */
  emitIntervalMs?: number
  /** Optional explicit display refresh rate (Hz) bypassing auto-detection. */
  targetRefreshRateHz?: number
  /** Multiplier on frameBudgetMs above which a frame counts as dropped/jank. Default: 1.2. */
  jankToleranceRatio?: number
  /** Frame gaps (ms) above this threshold are treated as tab/system pause rather than jank. Default: 5000. */
  maxFrameGapMs?: number
  /** Maximum distinct custom metric names tracked before ignoring unseen names. Default: 64. */
  maxCustomMetrics?: number
  /** Rolling sample count per custom metric used for p95 computation. Default: 120. */
  customMetricWindowSize?: number
  /** Optional clock override (defaults to performance.now / Date.now). */
  now?: () => number
  /** Optional requestAnimationFrame override. */
  requestFrame?: (callback: (timestamp: number) => void) => number
  /** Optional cancelAnimationFrame override. */
  cancelFrame?: (handle: number) => void
}

export interface PerfEngineLike {
  acquire(): () => void
  start(): void
  stop(): void
  reset(): void
  flush(): PerfSnapshot
  isRunning(): boolean
  getSnapshot(): PerfSnapshot
  getServerSnapshot?(): PerfSnapshot
  getMetrics(): PerfSnapshot
  subscribe(listener: () => void): () => void
  onEvent(listener: (event: PerfEvent) => void): () => void
  markStart(name: string): void
  markEnd(name: string): number | null
  recordDuration(name: string, durationMs: number): void
  recordMetric(name: string, durationMs: number): void
  now(): number
}

export type BenchmarkPhase = 'baseline' | 'active'
export type BenchmarkState = 'idle' | 'recording-baseline' | 'recording-active'
export type ResourceCostRating = 'Negligible' | 'Low' | 'Moderate' | 'Heavy'

export interface BenchmarkPhaseSnapshot {
  phase: BenchmarkPhase
  startedAt: number
  endedAt: number
  durationMs: number
  frameCount: number
  fps: number
  avgFrameTimeMs: number
  p95FrameTimeMs: number
  p99FrameTimeMs: number
  minFrameTimeMs: number
  maxFrameTimeMs: number
  refreshRateHz: number
  frameBudgetMs: number
  droppedFrames: number
  severeJankFrames: number
  jankPercent: number
  longTaskCount: number
  totalBlockingTimeMs: number
  maxLongTaskMs: number
  jsHeapStartMb: number | null
  jsHeapEndMb: number | null
  jsHeapDeltaMb: number | null
  customMetrics: Record<string, CustomMetricStats>
}

export interface CustomMetricDelta {
  name: string
  baselineAvgMs: number | null
  activeAvgMs: number | null
  avgDeltaMs: number | null
  baselineCount: number
  activeCount: number
  activeTotalMs: number
}

export interface BenchmarkDelta {
  /** active.fps - baseline.fps (negative means FPS dropped with effects ON). */
  fpsDelta: number
  /** Percentage change in FPS relative to baseline. */
  fpsDeltaPercent: number
  /** active.avgFrameTimeMs - baseline.avgFrameTimeMs (positive means slower frames). */
  frameTimeDeltaMs: number
  /** active.p95FrameTimeMs - baseline.p95FrameTimeMs. */
  p95FrameTimeDeltaMs: number
  /** active.p99FrameTimeMs - baseline.p99FrameTimeMs. */
  p99FrameTimeDeltaMs: number
  /** Percentage-point change in jank rate (active.jankPercent - baseline.jankPercent). */
  jankIncreasePercent: number
  /** active.droppedFrames - baseline.droppedFrames. */
  droppedFramesDelta: number
  /** active.totalBlockingTimeMs - baseline.totalBlockingTimeMs. */
  mainThreadBlockingDeltaMs: number
  /** active.longTaskCount - baseline.longTaskCount. */
  longTaskCountDelta: number
  /** active.jsHeapEndMb - baseline.jsHeapEndMb (null when memory API unavailable). */
  memoryDeltaMb: number | null
  /** Custom operation metric comparison between baseline and active phases. */
  customMetricsDelta: Record<string, CustomMetricDelta>
}

export interface BenchmarkAssessment {
  /** 0-100 performance score (100 = negligible cost, 0 = severe degradation). */
  score: number
  costRating: ResourceCostRating
  summary: string
}

export interface BenchmarkEnvironment {
  userAgent: string
  devicePixelRatio: number
  refreshRateHz: number
  frameBudgetMs: number
  hardwareConcurrency: number | null
  deviceMemoryGb: number | null
  prefersReducedMotion: boolean
  longTaskSupported: boolean
  memorySupported: boolean
}

export interface BenchmarkReport {
  schemaVersion: '1.0.0'
  generatedAt: string
  label?: string
  environment: BenchmarkEnvironment
  baseline: BenchmarkPhaseSnapshot
  active: BenchmarkPhaseSnapshot
  delta: BenchmarkDelta
  assessment: BenchmarkAssessment
}

export interface BenchmarkRunnerOptions {
  /** Optional descriptive label embedded in exported diagnostic reports. */
  label?: string
}

export type QualityTier = 'high' | 'medium' | 'low' | 'minimal'

export const QUALITY_TIERS: readonly QualityTier[] = [
  'high',
  'medium',
  'low',
  'minimal',
] as const

export interface AdaptiveQualityOptions {
  /** FPS below which sustained frame drops trigger a step-down. Default: 45. */
  minFpsThreshold?: number
  /** Automatically step down quality tier during sustained frame drops. Default: true. */
  autoDowngrade?: boolean
  /** Duration (ms) FPS must stay below minFpsThreshold before stepping down. Default: 1500. */
  downgradeDelayMs?: number
  /** Cooldown (ms) after any automatic tier transition before evaluating the next. Default: 1500. */
  cooldownMs?: number
  /** Sliding window (ms) over recent frames used for responsive FPS checks. Default: 600. */
  evaluationWindowMs?: number
  /** Minimum frames in the evaluation window before triggering adaptation. Default: 10. */
  minSampleFrames?: number
  /** Starting quality tier. Default: 'high'. */
  initialTier?: QualityTier
  /** Optionally step quality back up when FPS recovers cleanly. Default: false. */
  autoRecover?: boolean
  /** FPS required to step back up when autoRecover is true. */
  recoveryFpsThreshold?: number
  /** Duration (ms) FPS must stay above recoveryFpsThreshold before stepping up. Default: 5000. */
  recoveryDelayMs?: number
  /** Start at 'minimal' when OS prefers-reduced-motion is active. Default: false. */
  respectReducedMotion?: boolean
  /** Optional PerfEngine instance (defaults to global perfMonitor singleton). */
  engine?: PerfEngineLike
  /** Whether the hook actively acquires the telemetry engine while mounted. Default: true. */
  enabled?: boolean
}

export interface AdaptiveQualityState {
  qualityTier: QualityTier
  isDegraded: boolean
  isManualOverride: boolean
  downgradeCount: number
  metrics: PerfSnapshot
}

export interface UseAdaptiveQualityResult extends AdaptiveQualityState {
  setManualTier: (tier: QualityTier | null) => void
  resetToAuto: () => void
}
