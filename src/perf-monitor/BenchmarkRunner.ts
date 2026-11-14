import {
  DEFAULT_REFRESH_RATE_HZ,
  DEFAULT_TIMED_DURATION_MS,
  MAX_PHASE_FRAME_SAMPLES,
} from './constants'
import { perfMonitor } from './PerfEngine'
import { CustomMetricTracker, clamp, computePercentile, round2 } from './stats'
import type {
  BenchmarkAssessment,
  BenchmarkDelta,
  BenchmarkEnvironment,
  BenchmarkPhase,
  BenchmarkPhaseSnapshot,
  BenchmarkReport,
  BenchmarkRunnerOptions,
  BenchmarkState,
  CustomMetricDelta,
  PerfEngineLike,
  PerfEvent,
  PerfSnapshot,
  ResourceCostRating,
} from './types'

interface ActivePhaseSession {
  phase: BenchmarkPhase
  startedAt: number
  jsHeapStartMb: number | null
  frameSamples: number[]
  frameCount: number
  frameTimeSum: number
  minFrameTimeMs: number
  maxFrameTimeMs: number
  longTaskCount: number
  totalBlockingTimeMs: number
  maxLongTaskMs: number
  customTracker: CustomMetricTracker
  releaseEngine: () => void
  unsubscribeEvents: () => void
  cancelTimer?: () => void
}

function classifyCostRating(score: number): ResourceCostRating {
  if (score >= 90) return 'Negligible'
  if (score >= 75) return 'Low'
  if (score >= 50) return 'Moderate'
  return 'Heavy'
}

function formatSigned(value: number, unit: string): string {
  const prefix = value > 0 ? '+' : ''
  return `${prefix}${round2(value)}${unit}`
}

function buildAssessment(
  baseline: BenchmarkPhaseSnapshot,
  active: BenchmarkPhaseSnapshot,
  delta: BenchmarkDelta,
): BenchmarkAssessment {
  const budgetMs =
    active.frameBudgetMs > 0 ? active.frameBudgetMs : 1000 / DEFAULT_REFRESH_RATE_HZ

  const fpsDropPct =
    baseline.fps > 0 ? Math.max(0, ((baseline.fps - active.fps) / baseline.fps) * 100) : 0
  const fpsPenalty = Math.min(35, fpsDropPct * 1.1)
  const avgFramePenalty = Math.min(20, (Math.max(0, delta.frameTimeDeltaMs) / budgetMs) * 20)

  const p95Anchor = Math.max(baseline.p95FrameTimeMs, budgetMs)
  const p95OverRatio = Math.max(0, (active.p95FrameTimeMs - p95Anchor) / budgetMs)
  const p95Penalty = Math.min(15, p95OverRatio * 12)
  const jankPenalty = Math.min(20, Math.max(0, delta.jankIncreasePercent) * 1.2)

  const activeDurationSec = active.durationMs > 0 ? active.durationMs / 1000 : 1
  const tbtRateMsPerSec = Math.max(0, delta.mainThreadBlockingDeltaMs) / activeDurationSec
  const tbtPenalty = Math.min(30, tbtRateMsPerSec * 0.12)

  const totalPenalty = fpsPenalty + avgFramePenalty + p95Penalty + jankPenalty + tbtPenalty
  const score = Math.round(clamp(100 - totalPenalty, 0, 100))
  const costRating = classifyCostRating(score)

  const summary =
    `${costRating} UI effect cost (score ${score}/100): ` +
    `FPS ${formatSigned(delta.fpsDelta, '')} (${formatSigned(delta.fpsDeltaPercent, '%')}), ` +
    `frame time ${formatSigned(delta.frameTimeDeltaMs, 'ms')}, ` +
    `jank ${formatSigned(delta.jankIncreasePercent, '%')}, ` +
    `TBT ${formatSigned(delta.mainThreadBlockingDeltaMs, 'ms')}.`

  return { score, costRating, summary }
}

function buildCustomMetricsDelta(
  baselineMetrics: BenchmarkPhaseSnapshot['customMetrics'],
  activeMetrics: BenchmarkPhaseSnapshot['customMetrics'],
): Record<string, CustomMetricDelta> {
  const names = new Set<string>([
    ...Object.keys(baselineMetrics),
    ...Object.keys(activeMetrics),
  ])
  const delta: Record<string, CustomMetricDelta> = {}

  for (const name of names) {
    const base = baselineMetrics[name]
    const act = activeMetrics[name]
    const baselineAvgMs = base ? base.avgMs : null
    const activeAvgMs = act ? act.avgMs : null
    delta[name] = {
      name,
      baselineAvgMs,
      activeAvgMs,
      avgDeltaMs:
        baselineAvgMs !== null && activeAvgMs !== null
          ? round2(activeAvgMs - baselineAvgMs)
          : null,
      baselineCount: base ? base.count : 0,
      activeCount: act ? act.count : 0,
      activeTotalMs: act ? act.totalMs : 0,
    }
  }

  return delta
}

export class BenchmarkRunner {
  private readonly engine: PerfEngineLike
  private readonly label?: string

  private activeSession: ActivePhaseSession | null = null
  private baselineSnapshot: BenchmarkPhaseSnapshot | null = null
  private activeSnapshot: BenchmarkPhaseSnapshot | null = null
  private latestEngineSnapshot: PerfSnapshot

  constructor(engine: PerfEngineLike = perfMonitor, options: BenchmarkRunnerOptions = {}) {
    this.engine = engine
    this.label = options.label
    this.latestEngineSnapshot = engine.getSnapshot()
  }

  getState(): BenchmarkState {
    if (!this.activeSession) return 'idle'
    return this.activeSession.phase === 'baseline' ? 'recording-baseline' : 'recording-active'
  }

  hasBaseline(): boolean {
    return this.baselineSnapshot !== null
  }

  hasActive(): boolean {
    return this.activeSnapshot !== null
  }

  canCompare(): boolean {
    return this.baselineSnapshot !== null && this.activeSnapshot !== null
  }

  getBaseline(): BenchmarkPhaseSnapshot | null {
    return this.baselineSnapshot
  }

  getActive(): BenchmarkPhaseSnapshot | null {
    return this.activeSnapshot
  }

  startBaseline(): void {
    this.startPhase('baseline')
  }

  stopBaseline(): BenchmarkPhaseSnapshot {
    return this.stopPhase('baseline')
  }

  startActive(): void {
    this.startPhase('active')
  }

  stopActive(): BenchmarkPhaseSnapshot {
    return this.stopPhase('active')
  }

  startPhase(phase: BenchmarkPhase): void {
    if (this.activeSession) {
      throw new Error(
        `Cannot start "${phase}" phase while "${this.activeSession.phase}" phase is recording. Call stop or cancel() first.`,
      )
    }

    const releaseEngine = this.engine.acquire()
    const startSnapshot = this.engine.flush()
    this.latestEngineSnapshot = startSnapshot

    const session: ActivePhaseSession = {
      phase,
      startedAt: this.engine.now(),
      jsHeapStartMb: startSnapshot.jsHeapUsedMb,
      frameSamples: [],
      frameCount: 0,
      frameTimeSum: 0,
      minFrameTimeMs: Number.POSITIVE_INFINITY,
      maxFrameTimeMs: 0,
      longTaskCount: 0,
      totalBlockingTimeMs: 0,
      maxLongTaskMs: 0,
      customTracker: new CustomMetricTracker(),
      releaseEngine,
      unsubscribeEvents: () => {},
    }

    session.unsubscribeEvents = this.engine.onEvent((event: PerfEvent) => {
      if (event.type === 'frame') {
        session.frameCount += 1
        session.frameTimeSum += event.deltaMs
        if (event.deltaMs < session.minFrameTimeMs) session.minFrameTimeMs = event.deltaMs
        if (event.deltaMs > session.maxFrameTimeMs) session.maxFrameTimeMs = event.deltaMs
        if (session.frameSamples.length < MAX_PHASE_FRAME_SAMPLES) {
          session.frameSamples.push(event.deltaMs)
        }
      } else if (event.type === 'longtask') {
        session.longTaskCount += 1
        session.totalBlockingTimeMs += event.blockingTimeMs
        if (event.durationMs > session.maxLongTaskMs) {
          session.maxLongTaskMs = event.durationMs
        }
      } else if (event.type === 'metric') {
        session.customTracker.record(event.name, event.durationMs)
      }
    })

    this.activeSession = session
  }

  stopPhase(expectedPhase?: BenchmarkPhase): BenchmarkPhaseSnapshot {
    const session = this.activeSession
    if (!session) {
      throw new Error('No benchmark recording is currently active.')
    }
    if (expectedPhase && session.phase !== expectedPhase) {
      throw new Error(
        `Expected to stop "${expectedPhase}" phase, but "${session.phase}" is currently recording.`,
      )
    }

    session.cancelTimer?.()
    session.unsubscribeEvents()
    const endSnapshot = this.engine.flush()
    this.latestEngineSnapshot = endSnapshot
    const endedAt = this.engine.now()
    session.releaseEngine()
    this.activeSession = null

    const phaseResult = this.finalizeSession(session, endSnapshot, endedAt)
    if (phaseResult.phase === 'baseline') {
      this.baselineSnapshot = phaseResult
    } else {
      this.activeSnapshot = phaseResult
    }
    return phaseResult
  }

  recordBaseline(
    durationMs = DEFAULT_TIMED_DURATION_MS,
    signal?: AbortSignal,
  ): Promise<BenchmarkPhaseSnapshot> {
    return this.recordPhase('baseline', durationMs, signal)
  }

  recordActive(
    durationMs = DEFAULT_TIMED_DURATION_MS,
    signal?: AbortSignal,
  ): Promise<BenchmarkPhaseSnapshot> {
    return this.recordPhase('active', durationMs, signal)
  }

  recordPhase(
    phase: BenchmarkPhase,
    durationMs = DEFAULT_TIMED_DURATION_MS,
    signal?: AbortSignal,
  ): Promise<BenchmarkPhaseSnapshot> {
    if (signal?.aborted) {
      return Promise.reject(new Error('Benchmark recording aborted.'))
    }
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      return Promise.reject(new Error('Benchmark recording durationMs must be > 0.'))
    }

    this.startPhase(phase)
    const session = this.activeSession!

    return new Promise<BenchmarkPhaseSnapshot>((resolve, reject) => {
      let settled = false

      const cleanupListeners = () => {
        clearTimeout(timerId)
        signal?.removeEventListener('abort', onAbort)
      }

      const onAbort = () => {
        if (settled) return
        settled = true
        cleanupListeners()
        if (this.activeSession === session) {
          this.teardownActiveSession(session)
        }
        reject(new Error('Benchmark recording cancelled.'))
      }

      const timerId = setTimeout(() => {
        if (settled) return
        settled = true
        cleanupListeners()
        try {
          resolve(this.stopPhase(phase))
        } catch (err) {
          reject(err)
        }
      }, durationMs)

      session.cancelTimer = () => {
        if (settled) return
        settled = true
        cleanupListeners()
        reject(new Error('Benchmark recording cancelled.'))
      }

      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  captureSnapshot(
    phase: BenchmarkPhase,
    snapshot: PerfSnapshot = this.engine.flush(),
  ): BenchmarkPhaseSnapshot {
    this.latestEngineSnapshot = snapshot
    const nowTs = snapshot.timestamp
    const estimatedDuration =
      snapshot.windowFrames > 0 ? snapshot.windowFrames * snapshot.avgFrameTime : 0
    const phaseSnap: BenchmarkPhaseSnapshot = {
      phase,
      startedAt: round2(Math.max(0, nowTs - estimatedDuration)),
      endedAt: nowTs,
      durationMs: round2(estimatedDuration),
      frameCount: snapshot.windowFrames,
      fps: snapshot.fps,
      avgFrameTimeMs: snapshot.avgFrameTime,
      p95FrameTimeMs: snapshot.p95FrameTime,
      p99FrameTimeMs: snapshot.p99FrameTime,
      minFrameTimeMs: snapshot.minFrameTime,
      maxFrameTimeMs: snapshot.maxFrameTime,
      refreshRateHz: snapshot.refreshRateHz,
      frameBudgetMs: snapshot.frameBudgetMs,
      droppedFrames: Math.round((snapshot.jankPercent / 100) * snapshot.windowFrames),
      severeJankFrames: snapshot.severeJankFrames,
      jankPercent: snapshot.jankPercent,
      longTaskCount: snapshot.longTaskCount,
      totalBlockingTimeMs: snapshot.totalBlockingTimeMs,
      maxLongTaskMs: snapshot.maxLongTaskMs,
      jsHeapStartMb: snapshot.jsHeapUsedMb,
      jsHeapEndMb: snapshot.jsHeapUsedMb,
      jsHeapDeltaMb: snapshot.jsHeapUsedMb !== null ? 0 : null,
      customMetrics: { ...snapshot.customMetrics },
    }

    if (phase === 'baseline') {
      this.baselineSnapshot = phaseSnap
    } else {
      this.activeSnapshot = phaseSnap
    }
    return phaseSnap
  }

  cancel(): void {
    if (!this.activeSession) return
    const session = this.activeSession
    this.teardownActiveSession(session)
    session.cancelTimer?.()
  }

  reset(): void {
    this.cancel()
    this.baselineSnapshot = null
    this.activeSnapshot = null
  }

  compare(): BenchmarkReport {
    return this.getReport()
  }

  getReport(): BenchmarkReport {
    if (!this.baselineSnapshot || !this.activeSnapshot) {
      throw new Error(
        'Both baseline and active snapshots must be recorded before generating a comparison report.',
      )
    }

    const baseline = this.baselineSnapshot
    const active = this.activeSnapshot
    const envSnap = this.latestEngineSnapshot

    const delta: BenchmarkDelta = {
      fpsDelta: round2(active.fps - baseline.fps),
      fpsDeltaPercent:
        baseline.fps > 0 ? round2(((active.fps - baseline.fps) / baseline.fps) * 100) : 0,
      frameTimeDeltaMs: round2(active.avgFrameTimeMs - baseline.avgFrameTimeMs),
      p95FrameTimeDeltaMs: round2(active.p95FrameTimeMs - baseline.p95FrameTimeMs),
      p99FrameTimeDeltaMs: round2(active.p99FrameTimeMs - baseline.p99FrameTimeMs),
      jankIncreasePercent: round2(active.jankPercent - baseline.jankPercent),
      droppedFramesDelta: active.droppedFrames - baseline.droppedFrames,
      mainThreadBlockingDeltaMs: round2(
        active.totalBlockingTimeMs - baseline.totalBlockingTimeMs,
      ),
      longTaskCountDelta: active.longTaskCount - baseline.longTaskCount,
      memoryDeltaMb:
        baseline.jsHeapEndMb !== null && active.jsHeapEndMb !== null
          ? round2(active.jsHeapEndMb - baseline.jsHeapEndMb)
          : null,
      customMetricsDelta: buildCustomMetricsDelta(baseline.customMetrics, active.customMetrics),
    }

    const assessment = buildAssessment(baseline, active, delta)

    const environment: BenchmarkEnvironment = {
      userAgent: envSnap.deviceHints.userAgent,
      devicePixelRatio: envSnap.deviceHints.devicePixelRatio,
      refreshRateHz: active.refreshRateHz || envSnap.refreshRateHz,
      frameBudgetMs: active.frameBudgetMs || envSnap.frameBudgetMs,
      hardwareConcurrency: envSnap.deviceHints.hardwareConcurrency,
      deviceMemoryGb: envSnap.deviceHints.deviceMemoryGb,
      prefersReducedMotion: envSnap.deviceHints.prefersReducedMotion,
      longTaskSupported: envSnap.longTaskSupported,
      memorySupported: envSnap.jsHeapUsedMb !== null,
    }

    return {
      schemaVersion: '1.0.0',
      generatedAt: new Date().toISOString(),
      ...(this.label ? { label: this.label } : {}),
      environment,
      baseline,
      active,
      delta,
      assessment,
    }
  }

  getReportJSON(pretty = true): string {
    return JSON.stringify(this.getReport(), null, pretty ? 2 : 0)
  }

  private teardownActiveSession(session: ActivePhaseSession): void {
    session.unsubscribeEvents()
    session.releaseEngine()
    if (this.activeSession === session) {
      this.activeSession = null
    }
  }

  private finalizeSession(
    session: ActivePhaseSession,
    endSnapshot: PerfSnapshot,
    endedAt: number,
  ): BenchmarkPhaseSnapshot {
    const frameCount = session.frameCount
    const refreshRateHz = endSnapshot.refreshRateHz
    const frameBudgetMs = endSnapshot.frameBudgetMs
    const jankThresholdMs = endSnapshot.jankThresholdMs
    const severeThresholdMs = frameBudgetMs * 2

    const avgFrameTimeMs = frameCount > 0 ? session.frameTimeSum / frameCount : 0
    const fps = avgFrameTimeMs > 0 ? 1000 / avgFrameTimeMs : 0

    let p95FrameTimeMs = 0
    let p99FrameTimeMs = 0
    let droppedFrames = 0
    let severeJankFrames = 0

    if (session.frameSamples.length > 0) {
      const sorted = session.frameSamples.slice().sort((a, b) => a - b)
      p95FrameTimeMs = round2(computePercentile(sorted, sorted.length, 0.95))
      p99FrameTimeMs = round2(computePercentile(sorted, sorted.length, 0.99))

      for (let i = 0; i < session.frameSamples.length; i++) {
        const dt = session.frameSamples[i]
        if (dt > jankThresholdMs) droppedFrames += 1
        if (dt > severeThresholdMs) severeJankFrames += 1
      }

      if (frameCount > session.frameSamples.length) {
        const scale = frameCount / session.frameSamples.length
        droppedFrames = Math.round(droppedFrames * scale)
        severeJankFrames = Math.round(severeJankFrames * scale)
      }
    }

    const jankPercent = frameCount > 0 ? (droppedFrames / frameCount) * 100 : 0
    const jsHeapEndMb = endSnapshot.jsHeapUsedMb
    const jsHeapDeltaMb =
      session.jsHeapStartMb !== null && jsHeapEndMb !== null
        ? round2(jsHeapEndMb - session.jsHeapStartMb)
        : null

    return {
      phase: session.phase,
      startedAt: round2(session.startedAt),
      endedAt: round2(endedAt),
      durationMs: round2(Math.max(0, endedAt - session.startedAt)),
      frameCount,
      fps: round2(fps),
      avgFrameTimeMs: round2(avgFrameTimeMs),
      p95FrameTimeMs,
      p99FrameTimeMs,
      minFrameTimeMs:
        frameCount > 0 && Number.isFinite(session.minFrameTimeMs)
          ? round2(session.minFrameTimeMs)
          : 0,
      maxFrameTimeMs: round2(session.maxFrameTimeMs),
      refreshRateHz,
      frameBudgetMs,
      droppedFrames,
      severeJankFrames,
      jankPercent: round2(jankPercent),
      longTaskCount: session.longTaskCount,
      totalBlockingTimeMs: round2(session.totalBlockingTimeMs),
      maxLongTaskMs: round2(session.maxLongTaskMs),
      jsHeapStartMb: session.jsHeapStartMb,
      jsHeapEndMb,
      jsHeapDeltaMb,
      customMetrics: session.customTracker.toRecord(),
    }
  }
}
