import type { QualityTier } from './types'

export const BYTES_PER_MB = 1024 * 1024

export const DEFAULT_WINDOW_SIZE = 120
export const DEFAULT_EMIT_INTERVAL_MS = 250
export const DEFAULT_REFRESH_RATE_HZ = 60
export const DEFAULT_JANK_TOLERANCE_RATIO = 1.2
export const DEFAULT_MAX_FRAME_GAP_MS = 5000
export const DEFAULT_MAX_OPEN_MARKS = 128
export const DEFAULT_MAX_OPEN_MARKS_PER_NAME = 64
export const DEFAULT_MAX_CUSTOM_METRICS = 64
export const DEFAULT_CUSTOM_METRIC_WINDOW_SIZE = 120
export const LONG_TASK_THRESHOLD_MS = 50

export const STANDARD_REFRESH_RATES = [60, 75, 90, 120, 144, 165, 240] as const
export const REFRESH_RATE_SAMPLE_MIN = 15
export const REFRESH_RATE_RESAMPLE_INTERVAL = 30
export const REFRESH_RATE_SNAP_TOLERANCE = 0.1

export const MAX_PHASE_FRAME_SAMPLES = 36_000
export const DEFAULT_TIMED_DURATION_MS = 3000

export const DEFAULT_ADAPTIVE_QUALITY_OPTIONS = {
  minFpsThreshold: 45,
  autoDowngrade: true,
  downgradeDelayMs: 1500,
  cooldownMs: 1500,
  evaluationWindowMs: 600,
  minSampleFrames: 10,
  initialTier: 'high' as QualityTier,
  autoRecover: false,
  recoveryFpsThreshold: undefined as number | undefined,
  recoveryDelayMs: 5000,
  respectReducedMotion: false,
}
