import { perfMonitor } from './PerfEngine'
import {
  QUALITY_TIERS,
  type AdaptiveQualityOptions,
  type AdaptiveQualityState,
  type PerfEngineLike,
  type PerfEvent,
  type PerfSnapshot,
  type QualityTier,
} from './types'

interface FrameSample {
  timestamp: number
  deltaMs: number
}

interface ResolvedOptions {
  minFpsThreshold: number
  autoDowngrade: boolean
  downgradeDelayMs: number
  cooldownMs: number
  evaluationWindowMs: number
  minSampleFrames: number
  initialTier: QualityTier
  autoRecover: boolean
  recoveryFpsThreshold?: number
  recoveryDelayMs: number
  respectReducedMotion: boolean
}

const DEFAULT_OPTIONS: ResolvedOptions = {
  minFpsThreshold: 45,
  autoDowngrade: true,
  downgradeDelayMs: 1500,
  cooldownMs: 1500,
  evaluationWindowMs: 600,
  minSampleFrames: 10,
  initialTier: 'high',
  autoRecover: false,
  recoveryFpsThreshold: undefined,
  recoveryDelayMs: 5000,
  respectReducedMotion: false,
}

function tierRank(tier: QualityTier): number {
  return QUALITY_TIERS.indexOf(tier)
}

function resolveOptions(
  input: AdaptiveQualityOptions = {},
): ResolvedOptions {
  return {
    minFpsThreshold:
      typeof input.minFpsThreshold === 'number' && Number.isFinite(input.minFpsThreshold)
        ? Math.max(1, input.minFpsThreshold)
        : DEFAULT_OPTIONS.minFpsThreshold,
    autoDowngrade: input.autoDowngrade ?? DEFAULT_OPTIONS.autoDowngrade,
    downgradeDelayMs:
      typeof input.downgradeDelayMs === 'number' && Number.isFinite(input.downgradeDelayMs)
        ? Math.max(0, input.downgradeDelayMs)
        : DEFAULT_OPTIONS.downgradeDelayMs,
    cooldownMs:
      typeof input.cooldownMs === 'number' && Number.isFinite(input.cooldownMs)
        ? Math.max(0, input.cooldownMs)
        : DEFAULT_OPTIONS.cooldownMs,
    evaluationWindowMs:
      typeof input.evaluationWindowMs === 'number' &&
      Number.isFinite(input.evaluationWindowMs)
        ? Math.max(100, input.evaluationWindowMs)
        : DEFAULT_OPTIONS.evaluationWindowMs,
    minSampleFrames:
      typeof input.minSampleFrames === 'number' && Number.isFinite(input.minSampleFrames)
        ? Math.max(2, Math.floor(input.minSampleFrames))
        : DEFAULT_OPTIONS.minSampleFrames,
    initialTier: input.initialTier ?? DEFAULT_OPTIONS.initialTier,
    autoRecover: input.autoRecover ?? DEFAULT_OPTIONS.autoRecover,
    recoveryFpsThreshold:
      typeof input.recoveryFpsThreshold === 'number' &&
      Number.isFinite(input.recoveryFpsThreshold)
        ? input.recoveryFpsThreshold
        : undefined,
    recoveryDelayMs:
      typeof input.recoveryDelayMs === 'number' && Number.isFinite(input.recoveryDelayMs)
        ? Math.max(0, input.recoveryDelayMs)
        : DEFAULT_OPTIONS.recoveryDelayMs,
    respectReducedMotion:
      input.respectReducedMotion ?? DEFAULT_OPTIONS.respectReducedMotion,
  }
}

/**
 * Framework-agnostic state machine that monitors live frame stability via
 * PerfEngine and steps quality tiers down (or optionally recovers) with
 * hysteresis and cooldowns to prevent visual thrashing.
 */
export class AdaptiveQualityController {
  private readonly engine: PerfEngineLike
  private readonly listeners = new Set<() => void>()

  private options: ResolvedOptions
  private autoTier: QualityTier
  private manualTier: QualityTier | null = null
  private downgradeCount = 0

  private recentFrames: FrameSample[] = []
  private recentSumMs = 0
  private belowThresholdSince: number | null = null
  private aboveRecoverySince: number | null = null
  private lastTransitionAt: number | null = null

  private connectionCount = 0
  private releaseEngine: (() => void) | null = null
  private unsubscribeSnapshot: (() => void) | null = null
  private unsubscribeEvents: (() => void) | null = null

  private cachedState: AdaptiveQualityState
  private readonly serverSnapshot: AdaptiveQualityState

  constructor(options: AdaptiveQualityOptions = {}) {
    this.engine = options.engine ?? perfMonitor
    this.options = resolveOptions(options)
    this.autoTier = this.computeStartingTier(this.engine.getSnapshot())
    this.cachedState = this.buildState(this.engine.getSnapshot())
    this.serverSnapshot = this.cachedState
  }

  getSnapshot(): AdaptiveQualityState {
    return this.cachedState
  }

  getServerSnapshot(): AdaptiveQualityState {
    return this.serverSnapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Connects to the telemetry engine (ref-counted so React StrictMode
   * mount/unmount cycles cleanly re-attach without leaking).
   */
  connect(): () => void {
    let disconnected = false
    this.connectionCount += 1

    if (this.connectionCount === 1) {
      this.unsubscribeSnapshot = this.engine.subscribe(this.handleEngineSnapshot)
      this.unsubscribeEvents = this.engine.onEvent(this.handleEngineEvent)
      this.releaseEngine = this.engine.acquire()
      this.syncState(this.engine.getSnapshot())
    }

    return () => {
      if (disconnected) return
      disconnected = true
      this.connectionCount = Math.max(0, this.connectionCount - 1)
      if (this.connectionCount === 0) {
        this.disconnectAll()
      }
    }
  }

  updateOptions(nextOptions: AdaptiveQualityOptions): void {
    const prevInitial = this.options.initialTier
    const prevReducedMotion = this.options.respectReducedMotion
    const prevAutoDowngrade = this.options.autoDowngrade
    this.options = resolveOptions(nextOptions)

    if (prevAutoDowngrade && !this.options.autoDowngrade) {
      this.belowThresholdSince = null
      this.aboveRecoverySince = null
    }

    if (
      this.manualTier === null &&
      this.downgradeCount === 0 &&
      (prevInitial !== this.options.initialTier ||
        prevReducedMotion !== this.options.respectReducedMotion)
    ) {
      this.autoTier = this.computeStartingTier(this.engine.getSnapshot())
    }

    this.syncState(this.engine.getSnapshot())
  }

  setManualTier(tier: QualityTier | null): void {
    if (tier === null) {
      this.resetToAuto()
      return
    }
    this.manualTier = tier
    this.belowThresholdSince = null
    this.aboveRecoverySince = null
    this.syncState(this.engine.getSnapshot())
  }

  resetToAuto(): void {
    this.manualTier = null
    this.autoTier = this.computeStartingTier(this.engine.getSnapshot())
    this.downgradeCount = 0
    this.resetEvaluationWindow()
    this.lastTransitionAt = null
    this.syncState(this.engine.getSnapshot())
  }

  private disconnectAll(): void {
    this.unsubscribeSnapshot?.()
    this.unsubscribeSnapshot = null
    this.unsubscribeEvents?.()
    this.unsubscribeEvents = null
    this.releaseEngine?.()
    this.releaseEngine = null
    this.resetEvaluationWindow()
  }

  private computeStartingTier(snapshot: PerfSnapshot): QualityTier {
    if (this.options.respectReducedMotion && snapshot.deviceHints.prefersReducedMotion) {
      return 'minimal'
    }
    return this.options.initialTier
  }

  private resetEvaluationWindow(): void {
    this.recentFrames = []
    this.recentSumMs = 0
    this.belowThresholdSince = null
    this.aboveRecoverySince = null
  }

  private readonly handleEngineSnapshot = (): void => {
    this.syncState(this.engine.getSnapshot())
  }

  private readonly handleEngineEvent = (event: PerfEvent): void => {
    if (event.type === 'reset') {
      this.resetEvaluationWindow()
      this.lastTransitionAt = null
      this.syncState(this.engine.getSnapshot())
      return
    }

    if (event.type !== 'frame') return
    this.evaluateFrame(event.timestamp, event.deltaMs)
  }

  private evaluateFrame(timestamp: number, deltaMs: number): void {
    if (this.manualTier !== null || !this.options.autoDowngrade) {
      return
    }

    if (
      this.lastTransitionAt !== null &&
      timestamp - this.lastTransitionAt < this.options.cooldownMs
    ) {
      return
    }

    this.recentFrames.push({ timestamp, deltaMs })
    this.recentSumMs += deltaMs

    while (
      this.recentFrames.length > 3 &&
      timestamp - this.recentFrames[0].timestamp > this.options.evaluationWindowMs
    ) {
      const removed = this.recentFrames.shift()!
      this.recentSumMs -= removed.deltaMs
    }

    const sampleCount = this.recentFrames.length
    const spanMs =
      sampleCount > 1 ? timestamp - this.recentFrames[0].timestamp : 0

    const hasEnoughSamples =
      sampleCount >= this.options.minSampleFrames ||
      (sampleCount >= 3 && spanMs >= this.options.evaluationWindowMs)

    if (!hasEnoughSamples || this.recentSumMs <= 0) {
      return
    }

    const recentAvgFrameTime = this.recentSumMs / sampleCount
    const recentFps = 1000 / recentAvgFrameTime
    const currentRank = tierRank(this.autoTier)

    if (recentFps < this.options.minFpsThreshold) {
      this.aboveRecoverySince = null
      if (currentRank < QUALITY_TIERS.length - 1) {
        if (this.belowThresholdSince === null) {
          this.belowThresholdSince = timestamp
        } else if (
          timestamp - this.belowThresholdSince >=
          this.options.downgradeDelayMs
        ) {
          this.autoTier = QUALITY_TIERS[currentRank + 1]
          this.downgradeCount += 1
          this.lastTransitionAt = timestamp
          this.resetEvaluationWindow()
          const fresh = this.engine.flush()
          this.syncState(fresh)
        }
      }
      return
    }

    this.belowThresholdSince = null

    if (this.options.autoRecover) {
      const baselineRank = tierRank(this.computeStartingTier(this.engine.getSnapshot()))
      if (currentRank > baselineRank) {
        const refreshHz = this.engine.getSnapshot().refreshRateHz || 60
        const defaultRecovery = Math.min(
          refreshHz * 0.95,
          this.options.minFpsThreshold + 8,
        )
        const recoveryThreshold =
          this.options.recoveryFpsThreshold ??
          Math.max(this.options.minFpsThreshold + 1, defaultRecovery)

        if (recentFps >= recoveryThreshold) {
          if (this.aboveRecoverySince === null) {
            this.aboveRecoverySince = timestamp
          } else if (
            timestamp - this.aboveRecoverySince >=
            this.options.recoveryDelayMs
          ) {
            this.autoTier = QUALITY_TIERS[currentRank - 1]
            this.lastTransitionAt = timestamp
            this.resetEvaluationWindow()
            const fresh = this.engine.flush()
            this.syncState(fresh)
          }
        } else {
          this.aboveRecoverySince = null
        }
      }
    }
  }

  private buildState(metrics: PerfSnapshot): AdaptiveQualityState {
    const qualityTier = this.manualTier ?? this.autoTier
    const isDegraded = tierRank(qualityTier) > tierRank(this.options.initialTier)
    return {
      qualityTier,
      isDegraded,
      isManualOverride: this.manualTier !== null,
      downgradeCount: this.downgradeCount,
      metrics,
    }
  }

  private syncState(metrics: PerfSnapshot): void {
    const next = this.buildState(metrics)
    const prev = this.cachedState

    if (
      prev.qualityTier === next.qualityTier &&
      prev.isDegraded === next.isDegraded &&
      prev.isManualOverride === next.isManualOverride &&
      prev.downgradeCount === next.downgradeCount &&
      prev.metrics === next.metrics
    ) {
      return
    }

    this.cachedState = next
    for (const listener of this.listeners) {
      listener()
    }
  }
}
