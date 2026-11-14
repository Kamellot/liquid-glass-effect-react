import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToString } from 'react-dom/server'
import {
  AdaptiveQualityController,
  BenchmarkRunner,
  PerfEngine,
  QUALITY_TIERS,
  perfMonitor,
  useAdaptiveQuality,
  usePerfMetrics,
} from '../src/perf-monitor/index'

interface MockFrameHarness {
  now: () => number
  advanceAndTick: (deltaMs: number) => void
  tickN: (count: number, deltaMs: number) => void
  requestFrame: (cb: (ts: number) => void) => number
  cancelFrame: (id: number) => void
  pendingCount: () => number
}

function createFrameHarness(startTime = 1000): MockFrameHarness {
  let time = startTime
  let nextId = 1
  const callbacks = new Map<number, (ts: number) => void>()

  return {
    now: () => time,
    requestFrame: (cb: (ts: number) => void) => {
      const id = nextId++
      callbacks.set(id, cb)
      return id
    },
    cancelFrame: (id: number) => {
      callbacks.delete(id)
    },
    pendingCount: () => callbacks.size,
    advanceAndTick: (deltaMs: number) => {
      time += deltaMs
      const batch = Array.from(callbacks.entries())
      callbacks.clear()
      for (const [, cb] of batch) {
        cb(time)
      }
    },
    tickN: (count: number, deltaMs: number) => {
      for (let i = 0; i < count; i++) {
        time += deltaMs
        const batch = Array.from(callbacks.entries())
        callbacks.clear()
        for (const [, cb] of batch) {
          cb(time)
        }
      }
    },
  }
}

test('PerfEngine: SSR safety, singleton, and ref-counted lifecycle', () => {
  assert.equal(typeof perfMonitor.getMetrics, 'function')
  assert.equal(typeof perfMonitor.getServerSnapshot, 'function')
  const snap = perfMonitor.getSnapshot()
  assert.strictEqual(snap, perfMonitor.getServerSnapshot())
  assert.equal(snap.isRunning, false)
  assert.equal(snap.jsHeapUsedMb, null)
  assert.equal(snap.fps, 0)
  assert.equal(snap.deviceHints.prefersReducedMotion, false)

  const harness = createFrameHarness()
  const engine = new PerfEngine({
    now: harness.now,
    requestFrame: harness.requestFrame,
    cancelFrame: harness.cancelFrame,
  })

  const release1 = engine.acquire()
  const release2 = engine.acquire()
  assert.equal(engine.isRunning(), true)
  assert.equal(harness.pendingCount(), 1)

  release1()
  release1()
  assert.equal(engine.isRunning(), true)

  release2()
  assert.equal(engine.isRunning(), false)
  assert.equal(harness.pendingCount(), 0)

  engine.start()
  assert.equal(engine.isRunning(), true)
  engine.stop()
  assert.equal(engine.isRunning(), false)
})

test('PerfEngine: rolling FPS, avgFrameTime, p95/p99, 60Hz vs 120Hz/144Hz detection & jank', () => {
  const harness = createFrameHarness(0)
  const engine = new PerfEngine({
    windowSize: 120,
    emitIntervalMs: 0,
    now: harness.now,
    requestFrame: harness.requestFrame,
    cancelFrame: harness.cancelFrame,
  })

  engine.start()
  harness.advanceAndTick(16)

  harness.tickN(100, 16.67)
  harness.tickN(20, 35)

  const metrics = engine.getMetrics()
  assert.equal(metrics.refreshRateHz, 60)
  assert.equal(metrics.windowFrames, 120)
  assert.equal(metrics.totalFrames, 120)
  assert.equal(metrics.droppedFrames, 20)
  assert.equal(metrics.severeJankFrames, 20)
  assert.equal(metrics.jankPercent, 16.67)
  assert.equal(metrics.p95FrameTime, 35)
  assert.equal(metrics.p99FrameTime, 35)
  assert.equal(metrics.minFrameTime, 16.67)
  assert.equal(metrics.maxFrameTime, 35)
  assert.ok(Math.abs(metrics.avgFrameTime - 19.73) <= 0.02)
  assert.ok(Math.abs(metrics.fps - 50.7) <= 0.1)

  // 120Hz detection even with 35% dropped frames (16.67ms drops)
  engine.reset()
  harness.advanceAndTick(8.33)
  harness.tickN(78, 8.33)
  harness.tickN(42, 16.67)

  const m120 = engine.getMetrics()
  assert.equal(m120.refreshRateHz, 120)
  assert.equal(m120.frameBudgetMs, 8.33)
  assert.equal(m120.droppedFrames, 42)
  assert.equal(m120.jankPercent, 35)

  // 144Hz detection
  engine.reset()
  harness.advanceAndTick(6.94)
  harness.tickN(30, 6.94)
  const m144 = engine.getMetrics()
  assert.equal(m144.refreshRateHz, 144)

  engine.stop()
})

test('PerfEngine: ignores massive sleep/tab-background gaps and keeps snapshot referentially stable', () => {
  const harness = createFrameHarness(0)
  const engine = new PerfEngine({
    windowSize: 10,
    emitIntervalMs: 250,
    maxFrameGapMs: 5000,
    now: harness.now,
    requestFrame: harness.requestFrame,
    cancelFrame: harness.cancelFrame,
  })

  let notifications = 0
  const unsub = engine.subscribe(() => {
    notifications++
  })

  engine.start()
  const s1 = engine.getSnapshot()
  const s2 = engine.getSnapshot()
  assert.strictEqual(s1, s2)

  harness.advanceAndTick(16.67)
  harness.tickN(5, 16.67)
  assert.ok(notifications >= 2)

  harness.advanceAndTick(12_000)
  harness.tickN(3, 16.67)
  const afterResume = engine.flush()
  assert.equal(afterResume.maxFrameTime, 16.67)
  assert.equal(afterResume.droppedFrames, 0)

  unsub()
  engine.stop()
})

test('PerfEngine: graceful fallbacks when longtask and performance.memory are unsupported', () => {
  const origPerfObserver = (globalThis as Record<string, unknown>).PerformanceObserver

  class FallbackObserver {
    static supportedEntryTypes = ['paint', 'mark', 'measure']
    observe() {
      throw new Error('longtask unsupported')
    }
    disconnect() {}
  }

  ;(globalThis as Record<string, unknown>).PerformanceObserver = FallbackObserver
  try {
    const engine = new PerfEngine({ emitIntervalMs: 0 })
    engine.start()
    const m = engine.getMetrics()
    assert.equal(m.longTaskSupported, false)
    assert.equal(m.jsHeapUsedMb, null)
    assert.equal(m.memory.usedJSHeapSizeMb, null)
    engine.stop()
  } finally {
    ;(globalThis as Record<string, unknown>).PerformanceObserver = origPerfObserver
  }
})

test('PerfEngine: LongTask PerformanceObserver, memory, device hints, and custom marks', () => {
  const origPerfObserver = (globalThis as Record<string, unknown>).PerformanceObserver
  const origPerf = globalThis.performance
  const origNav = globalThis.navigator
  const origWin = (globalThis as Record<string, unknown>).window

  let capturedObserverCb: ((list: { getEntries: () => Array<{ duration: number }> }) => void) | null = null
  let disconnected = false

  class MockPerfObserver {
    static supportedEntryTypes = ['longtask']
    constructor(cb: (list: { getEntries: () => Array<{ duration: number }> }) => void) {
      capturedObserverCb = cb
    }
    observe() {}
    disconnect() {
      disconnected = true
    }
  }

  ;(globalThis as Record<string, unknown>).PerformanceObserver = MockPerfObserver
  Object.defineProperty(globalThis, 'performance', {
    configurable: true,
    value: {
      now: () => 100,
      memory: {
        usedJSHeapSize: 42 * 1024 * 1024,
        totalJSHeapSize: 64 * 1024 * 1024,
        jsHeapSizeLimit: 2048 * 1024 * 1024,
      },
    },
  })
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      hardwareConcurrency: 8,
      deviceMemory: 8,
      userAgent: 'MockBrowser/130',
    },
  })
  ;(globalThis as Record<string, unknown>).window = {
    devicePixelRatio: 2,
    matchMedia: () => ({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  }

  try {
    let time = 100
    const engine = new PerfEngine({
      emitIntervalMs: 0,
      now: () => time,
    })
    engine.start()

    const init = engine.getMetrics()
    assert.equal(init.longTaskSupported, true)
    assert.equal(init.jsHeapUsedMb, 42)
    assert.equal(init.memory.totalJSHeapSizeMb, 64)
    assert.equal(init.deviceHints.hardwareConcurrency, 8)
    assert.equal(init.deviceHints.deviceMemoryGb, 8)
    assert.equal(init.deviceHints.devicePixelRatio, 2)
    assert.equal(init.deviceHints.prefersReducedMotion, true)
    assert.equal(init.deviceHints.estimatedTier, 'high')
    assert.equal(init.deviceHints.userAgent, 'MockBrowser/130')

    assert.ok(capturedObserverCb !== null)
    capturedObserverCb!({
      getEntries: () => [
        { duration: 30 },
        { duration: 85 },
        { duration: 150 },
      ],
    })

    const m = engine.flush()
    assert.equal(m.longTaskCount, 2)
    assert.equal(m.totalBlockingTimeMs, 135)
    assert.equal(m.maxLongTaskMs, 150)

    engine.markStart('sdf-generation')
    time += 12.5
    engine.markStart('sdf-generation')
    time += 4.5
    assert.equal(engine.markEnd('sdf-generation'), 4.5)
    time += 3.0
    assert.equal(engine.markEnd('sdf-generation'), 20)
    assert.equal(engine.markEnd('nonexistent'), null)

    engine.recordMetric('sdf-generation', 10)
    engine.recordDuration('sdf-generation', 15.5)

    assert.throws(() => {
      engine.measure('fail-op', () => {
        time += 7
        throw new Error('boom')
      })
    }, /boom/)

    const custom = engine.flush().customMetrics
    assert.equal(custom['sdf-generation'].count, 4)
    assert.equal(custom['sdf-generation'].totalMs, 50)
    assert.equal(custom['sdf-generation'].minMs, 4.5)
    assert.equal(custom['sdf-generation'].maxMs, 20)
    assert.equal(custom['sdf-generation'].lastMs, 15.5)
    assert.equal(custom['fail-op'].count, 1)
    assert.equal(custom['fail-op'].avgMs, 7)

    engine.stop()
    assert.equal(disconnected, true)
  } finally {
    ;(globalThis as Record<string, unknown>).PerformanceObserver = origPerfObserver
    Object.defineProperty(globalThis, 'performance', {
      configurable: true,
      value: origPerf,
    })
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: origNav,
    })
    ;(globalThis as Record<string, unknown>).window = origWin
  }
})

test('BenchmarkRunner: manual A/B comparison, phase isolation, rating tiers, memory/TBT deltas & JSON export', () => {
  const origPerf = globalThis.performance
  let usedHeapBytes = 30 * 1024 * 1024

  Object.defineProperty(globalThis, 'performance', {
    configurable: true,
    value: {
      now: () => 0,
      memory: {
        get usedJSHeapSize() {
          return usedHeapBytes
        },
        totalJSHeapSize: 128 * 1024 * 1024,
        jsHeapSizeLimit: 2048 * 1024 * 1024,
      },
    },
  })

  try {
    const harness = createFrameHarness(0)
    const engine = new PerfEngine({
      windowSize: 120,
      emitIntervalMs: 0,
      now: harness.now,
      requestFrame: harness.requestFrame,
      cancelFrame: harness.cancelFrame,
    })

    const runner = new BenchmarkRunner(engine, { label: 'LiquidGlass Stress Test' })
    assert.equal(runner.getState(), 'idle')
    assert.equal(runner.canCompare(), false)
    assert.throws(() => runner.getReport(), /Both baseline and active/)

    engine.recordMetric('pre-existing', 99)

    const frame60Hz = 1000 / 60
    runner.startBaseline()
    assert.equal(runner.getState(), 'recording-baseline')
    assert.throws(() => runner.startActive(), /Cannot start "active"/)

    harness.advanceAndTick(frame60Hz)
    harness.tickN(120, frame60Hz)
    const baseline = runner.stopBaseline()
    assert.equal(runner.getState(), 'idle')
    assert.equal(baseline.frameCount, 120)
    assert.equal(baseline.fps, 60)
    assert.equal(baseline.droppedFrames, 0)
    assert.equal(baseline.jsHeapEndMb, 30)
    assert.equal(baseline.customMetrics['pre-existing'], undefined)

    runner.startActive()
    assert.equal(runner.getState(), 'recording-active')
    usedHeapBytes = 48 * 1024 * 1024
    harness.advanceAndTick(25)
    harness.tickN(90, 25)
    engine.recordMetric('sdf-generation', 3.4)
    engine.recordMetric('sdf-generation', 4.6)

    const active = runner.stopActive()
    assert.equal(active.frameCount, 90)
    assert.equal(active.fps, 40)
    assert.equal(active.droppedFrames, 90)
    assert.equal(active.jankPercent, 100)
    assert.equal(active.jsHeapStartMb, 30)
    assert.equal(active.jsHeapEndMb, 48)
    assert.equal(active.jsHeapDeltaMb, 18)
    assert.equal(active.customMetrics['sdf-generation'].avgMs, 4)

    assert.equal(runner.canCompare(), true)
    const report = runner.compare()
    assert.equal(report.schemaVersion, '1.0.0')
    assert.equal(report.label, 'LiquidGlass Stress Test')
    assert.equal(report.delta.fpsDelta, -20)
    assert.equal(report.delta.fpsDeltaPercent, -33.33)
    assert.equal(report.delta.frameTimeDeltaMs, 8.33)
    assert.equal(report.delta.jankIncreasePercent, 100)
    assert.equal(report.delta.droppedFramesDelta, 90)
    assert.equal(report.delta.memoryDeltaMb, 18)
    assert.equal(report.delta.customMetricsDelta['sdf-generation'].activeCount, 2)
    assert.equal(report.delta.customMetricsDelta['sdf-generation'].baselineAvgMs, null)
    assert.equal(report.assessment.costRating, 'Heavy')
    assert.ok(report.assessment.score < 50)

    const json = runner.getReportJSON()
    const parsed = JSON.parse(json)
    assert.equal(parsed.environment.refreshRateHz, 60)
    assert.equal(parsed.environment.memorySupported, true)
    assert.equal(parsed.assessment.costRating, 'Heavy')

    // Negligible impact test
    const negligibleRunner = new BenchmarkRunner(engine)
    negligibleRunner.startBaseline()
    harness.advanceAndTick(frame60Hz)
    harness.tickN(60, frame60Hz)
    negligibleRunner.stopBaseline()

    negligibleRunner.startActive()
    harness.advanceAndTick(frame60Hz)
    harness.tickN(60, frame60Hz)
    negligibleRunner.stopActive()
    const negReport = negligibleRunner.getReport()
    assert.equal(negReport.assessment.costRating, 'Negligible')
    assert.equal(negReport.assessment.score, 100)

    // Moderate impact test
    const modRunner = new BenchmarkRunner(engine)
    modRunner.startBaseline()
    harness.advanceAndTick(frame60Hz)
    harness.tickN(60, frame60Hz)
    modRunner.stopBaseline()

    modRunner.startActive()
    harness.advanceAndTick(frame60Hz)
    harness.tickN(54, 18.5)
    harness.tickN(6, 26)
    modRunner.stopActive()
    const modReport = modRunner.getReport()
    assert.equal(modReport.assessment.costRating, 'Moderate')
    assert.ok(modReport.assessment.score >= 50 && modReport.assessment.score < 75)
  } finally {
    Object.defineProperty(globalThis, 'performance', {
      configurable: true,
      value: origPerf,
    })
  }
})

test('BenchmarkRunner: captureSnapshot, timed recording, and cancellation', async () => {
  const harness = createFrameHarness(0)
  const engine = new PerfEngine({
    emitIntervalMs: 0,
    now: harness.now,
    requestFrame: harness.requestFrame,
    cancelFrame: harness.cancelFrame,
  })
  const runner = new BenchmarkRunner(engine)

  const p = runner.recordBaseline(40)
  assert.equal(runner.getState(), 'recording-baseline')
  harness.advanceAndTick(16.67)
  harness.tickN(3, 16.67)
  const baseline = await p
  assert.equal(runner.getState(), 'idle')
  assert.equal(baseline.frameCount, 3)

  const abortController = new AbortController()
  const activePromise = runner.recordActive(5000, abortController.signal)
  assert.equal(engine.isRunning(), true)
  abortController.abort()
  await assert.rejects(activePromise, /cancelled/)
  assert.equal(runner.getState(), 'idle')
  assert.equal(engine.isRunning(), false)

  engine.start()
  harness.advanceAndTick(16.67)
  harness.tickN(10, 16.67)
  const snapBaseline = runner.captureSnapshot('baseline')
  harness.tickN(10, 30)
  const snapActive = runner.captureSnapshot('active')
  engine.stop()
  assert.equal(snapBaseline.phase, 'baseline')
  assert.equal(snapActive.phase, 'active')
  assert.ok(runner.compare().delta.fpsDelta < 0)
})

test('AdaptiveQualityController: sustained step-down, transient immunity, manual override & recovery', () => {
  const harness = createFrameHarness(0)
  const engine = new PerfEngine({
    windowSize: 120,
    emitIntervalMs: 0,
    now: harness.now,
    requestFrame: harness.requestFrame,
    cancelFrame: harness.cancelFrame,
  })

  const controller = new AdaptiveQualityController({
    engine,
    minFpsThreshold: 45,
    autoDowngrade: true,
    downgradeDelayMs: 1500,
    cooldownMs: 1000,
    evaluationWindowMs: 600,
    minSampleFrames: 10,
    autoRecover: true,
    recoveryFpsThreshold: 55,
    recoveryDelayMs: 2000,
  })

  const tierHistory: string[] = []
  controller.subscribe(() => {
    const t = controller.getSnapshot().qualityTier
    if (tierHistory[tierHistory.length - 1] !== t) {
      tierHistory.push(t)
    }
  })

  const disconnect = controller.connect()
  assert.equal(controller.getSnapshot().qualityTier, 'high')
  assert.equal(controller.getSnapshot().isDegraded, false)

  harness.advanceAndTick(16.67)
  harness.tickN(60, 16.67)
  assert.equal(controller.getSnapshot().qualityTier, 'high')

  // Transient spike (500ms at 30 FPS, then back to 60 FPS) -> must NOT downgrade
  harness.tickN(15, 33.33)
  harness.tickN(60, 16.67)
  assert.equal(controller.getSnapshot().qualityTier, 'high')
  assert.equal(controller.getSnapshot().downgradeCount, 0)

  // Sustained 30 FPS for > 1.5s -> 'high' -> 'medium'
  harness.tickN(75, 33.33)
  assert.equal(controller.getSnapshot().qualityTier, 'medium')
  assert.equal(controller.getSnapshot().isDegraded, true)
  assert.equal(controller.getSnapshot().downgradeCount, 1)

  // Cooldown + sustained 25 FPS -> 'medium' -> 'low'
  harness.tickN(85, 40)
  assert.equal(controller.getSnapshot().qualityTier, 'low')

  // Continue dropping -> 'low' -> 'minimal'
  harness.tickN(85, 45)
  assert.equal(controller.getSnapshot().qualityTier, 'minimal')

  // Sustained recovery at 60 FPS -> 'minimal' -> 'low'
  harness.tickN(220, 16.67)
  assert.equal(controller.getSnapshot().qualityTier, 'low')

  // Manual override locks tier even under drop
  controller.setManualTier('high')
  assert.equal(controller.getSnapshot().qualityTier, 'high')
  assert.equal(controller.getSnapshot().isManualOverride, true)
  assert.equal(controller.getSnapshot().isDegraded, false)
  harness.tickN(90, 40)
  assert.equal(controller.getSnapshot().qualityTier, 'high')

  // Resetting manual override back to null resumes auto mode
  controller.setManualTier(null)
  assert.equal(controller.getSnapshot().isManualOverride, false)
  assert.equal(controller.getSnapshot().qualityTier, 'high')

  assert.deepEqual(QUALITY_TIERS, ['high', 'medium', 'low', 'minimal'])
  assert.ok(tierHistory.includes('medium'))
  assert.ok(tierHistory.includes('low'))
  assert.ok(tierHistory.includes('minimal'))

  disconnect()
  assert.equal(engine.isRunning(), false)
})

test('AdaptiveQualityController: autoDowngrade=false preserves high tier while updating metrics', () => {
  const harness = createFrameHarness(0)
  const engine = new PerfEngine({
    emitIntervalMs: 0,
    now: harness.now,
    requestFrame: harness.requestFrame,
    cancelFrame: harness.cancelFrame,
  })
  const controller = new AdaptiveQualityController({
    engine,
    minFpsThreshold: 45,
    autoDowngrade: false,
  })
  const disconnect = controller.connect()
  harness.advanceAndTick(40)
  harness.tickN(90, 40)
  const snap = controller.getSnapshot()
  assert.equal(snap.qualityTier, 'high')
  assert.equal(snap.isDegraded, false)
  assert.equal(snap.metrics.fps, 25)
  disconnect()
})

test('React hooks: useAdaptiveQuality and usePerfMetrics render cleanly in SSR', () => {
  function DemoProbe() {
    const { qualityTier, setManualTier, metrics, isDegraded } = useAdaptiveQuality({
      minFpsThreshold: 45,
      autoDowngrade: true,
    })
    const live = usePerfMetrics()
    return React.createElement(
      'div',
      {
        'data-tier': qualityTier,
        'data-degraded': String(isDegraded),
        'data-has-setter': String(typeof setManualTier === 'function'),
        'data-fps': String(metrics.fps),
        'data-live-fps': String(live.fps),
      },
      qualityTier,
    )
  }

  const html = renderToString(React.createElement(DemoProbe))
  assert.match(html, /data-tier="high"/)
  assert.match(html, /data-degraded="false"/)
  assert.match(html, /data-has-setter="true"/)
  assert.match(html, /data-fps="0"/)
  assert.match(html, /data-live-fps="0"/)
})
