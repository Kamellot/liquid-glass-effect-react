import { DEFAULT_ADAPTIVE_QUALITY_OPTIONS, DEFAULT_REFRESH_RATE_HZ } from './constants'
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

function resolveNumber(value: unknown, min: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, value) : fallback
}

function resolveOptions(input: AdaptiveQualityOptions = {}): ResolvedOptions {
  const defaults = DEFAULT_ADAPTIVE_QUALITY_OPTIONS
  return {
    minFpsThreshold: resolveNumber(input.minFpsThreshold, 1, defaults.minFpsThreshold),
    autoDowngrade: input.autoDowngrade ?? defaults.autoDowngrade,
    downgradeDelayMs: resolveNumber(input.downgradeDelayMs, 0, defaults.downgradeDelayMs),
    cooldownMs: resolveNumber(input.cooldownMs, 0, defaults.cooldownMs),
    evaluationWindowMs: resolveNumber(input.evaluationWindowMs, 100, defaults.evaluationWindowMs),
    minSampleFrames: Math.floor(resolveNumber(input.minSampleFrames, 2, defaults.minSampleFrames)),
    initialTier: input.initialTier ?? defaults.initialTier,
    autoRecover: input.autoRecover ?? defaults.autoRecover,
    recoveryFpsThreshold:
      typeof input.recoveryFpsThreshold === 'number' && Number.isFinite(input.recoveryFpsThreshold)
        ? input.recoveryFpsThreshold
        : undefined,
    recoveryDelayMs: resolveNumber(input.recoveryDelayMs, 0, defaults.recoveryDelayMs),
    respectReducedMotion: input.respectReducedMotion ?? defaults.respectReducedMotion,
  }
}

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
    const initialSnapshot = this.engine.getSnapshot()
    const initialServerSnapshot = this.engine.getServerSnapshot?.() ?? initialSnapshot
    this.autoTier = this.computeStartingTier(initialSnapshot)
    this.cachedState = this.buildState(initialSnapshot)
    this.serverSnapshot = this.buildState(initialServerSnapshot)
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
    if (event.type === 'frame') {
      this.evaluateFrame(event.timestamp, event.deltaMs)
    }
  }

  private evaluateFrame(timestamp: number, deltaMs: number): void {
    if (this.manualTier !== null || !this.options.autoDowngrade) return

    // Hold hysteresis cooldown after transitions to avoid visual thrashing.
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
      this.recentSumMs -= this.recentFrames.shift()!.deltaMs
    }

    const sampleCount = this.recentFrames.length
    const spanMs = sampleCount > 1 ? timestamp - this.recentFrames[0].timestamp : 0
    const hasEnoughSamples =
      sampleCount >= this.options.minSampleFrames ||
      (sampleCount >= 3 && spanMs >= this.options.evaluationWindowMs)

    if (!hasEnoughSamples || this.recentSumMs <= 0) return

    const recentFps = 1000 / (this.recentSumMs / sampleCount)
    const currentRank = QUALITY_TIERS.indexOf(this.autoTier)

    if (recentFps < this.options.minFpsThreshold) {
      this.aboveRecoverySince = null
      if (currentRank >= QUALITY_TIERS.length - 1) return

      if (this.belowThresholdSince === null) {
        this.belowThresholdSince = timestamp
      } else if (timestamp - this.belowThresholdSince >= this.options.downgradeDelayMs) {
        this.commitTierTransition(QUALITY_TIERS[currentRank + 1], timestamp, true)
      }
      return
    }

    this.belowThresholdSince = null
    if (!this.options.autoRecover) return

    const baselineRank = QUALITY_TIERS.indexOf(this.computeStartingTier(this.engine.getSnapshot()))
    if (currentRank <= baselineRank) return

    const refreshHz = this.engine.getSnapshot().refreshRateHz || DEFAULT_REFRESH_RATE_HZ
    const defaultRecovery = Math.min(refreshHz * 0.95, this.options.minFpsThreshold + 8)
    const recoveryThreshold =
      this.options.recoveryFpsThreshold ?? Math.max(this.options.minFpsThreshold + 1, defaultRecovery)

    if (recentFps < recoveryThreshold) {
      this.aboveRecoverySince = null
      return
    }

    if (this.aboveRecoverySince === null) {
      this.aboveRecoverySince = timestamp
    } else if (timestamp - this.aboveRecoverySince >= this.options.recoveryDelayMs) {
      this.commitTierTransition(QUALITY_TIERS[currentRank - 1], timestamp, false)
    }
  }

  private commitTierTransition(nextTier: QualityTier, timestamp: number, isDowngrade: boolean): void {
    this.autoTier = nextTier
    if (isDowngrade) this.downgradeCount += 1
    this.lastTransitionAt = timestamp
    this.resetEvaluationWindow()
    this.syncState(this.engine.flush())
  }

  private buildState(metrics: PerfSnapshot): AdaptiveQualityState {
    const qualityTier = this.manualTier ?? this.autoTier
    const isDegraded =
      QUALITY_TIERS.indexOf(qualityTier) > QUALITY_TIERS.indexOf(this.options.initialTier)
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
