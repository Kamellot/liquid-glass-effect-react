import { useCallback, useMemo, useState } from 'react'
import {
  BenchmarkRunner,
  QUALITY_TIERS,
  perfMonitor,
  useAdaptiveQuality,
  type BenchmarkReport,
  type QualityTier,
} from '../perf-monitor'

function getHealthStatus(fps: number, refreshRateHz: number, jankPercent: number, isDegraded: boolean) {
  if (fps <= 0) return 'idle'
  if (fps < Math.min(45, refreshRateHz * 0.65) || jankPercent >= 15) return 'lag'
  if (isDegraded || jankPercent >= 4 || fps < refreshRateHz * 0.85) return 'warn'
  return 'ok'
}

export function PerfObserverHud() {
  const {
    qualityTier,
    setManualTier,
    resetToAuto,
    metrics,
    isDegraded,
    isManualOverride,
  } = useAdaptiveQuality({
    minFpsThreshold: 45,
    autoDowngrade: true,
  })

  const [expanded, setExpanded] = useState(false)
  const runner = useMemo(
    () => new BenchmarkRunner(perfMonitor, { label: 'LiquidGlass Demo A/B' }),
    [],
  )
  const [benchState, setBenchState] = useState(() => runner.getState())
  const [hasBaseline, setHasBaseline] = useState(false)
  const [hasActive, setHasActive] = useState(false)
  const [report, setReport] = useState<BenchmarkReport | null>(null)
  const [copied, setCopied] = useState(false)

  const status = getHealthStatus(
    metrics.fps,
    metrics.refreshRateHz,
    metrics.jankPercent,
    isDegraded,
  )

  const syncBenchUi = useCallback(() => {
    setBenchState(runner.getState())
    setHasBaseline(runner.hasBaseline())
    setHasActive(runner.hasActive())
    setReport(runner.canCompare() ? runner.getReport() : null)
  }, [runner])

  const toggleBaseline = useCallback(() => {
    if (runner.getState() === 'recording-baseline') {
      runner.stopBaseline()
    } else if (runner.getState() === 'idle') {
      runner.startBaseline()
    }
    syncBenchUi()
  }, [runner, syncBenchUi])

  const toggleActive = useCallback(() => {
    if (runner.getState() === 'recording-active') {
      runner.stopActive()
    } else if (runner.getState() === 'idle') {
      runner.startActive()
    }
    syncBenchUi()
  }, [runner, syncBenchUi])

  const resetBench = useCallback(() => {
    runner.reset()
    setCopied(false)
    syncBenchUi()
  }, [runner, syncBenchUi])

  const copyReport = useCallback(async () => {
    if (!runner.canCompare()) return
    const json = runner.getReportJSON()
    try {
      await navigator.clipboard.writeText(json)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      // Fallback if clipboard permission is unavailable
      console.log(json)
    }
  }, [runner])

  return (
    <aside
      className={'perf-hud' + (expanded ? ' perf-hud--open' : '')}
      aria-label="Performance and lag observer"
    >
      <button
        type="button"
        className="perf-hud-pill"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className={`perf-dot perf-dot--${status}`} aria-hidden="true" />
        <span className="perf-hud-fps">
          {metrics.fps > 0 ? `${metrics.fps.toFixed(0)} FPS` : '… FPS'}
        </span>
        <span className="perf-hud-sep">·</span>
        <span className="perf-hud-meta">
          {metrics.avgFrameTime.toFixed(1)}ms
          {metrics.droppedFrames > 0 ? ` · ${metrics.droppedFrames} lag` : ''}
        </span>
        <span className="perf-hud-tier">{qualityTier}</span>
      </button>

      {expanded && (
        <div className="perf-hud-body">
          <div className="perf-hud-grid">
            <div className="perf-kv">
              <span>Refresh / Budget</span>
              <b>
                {metrics.refreshRateHz}Hz ({metrics.frameBudgetMs}ms)
              </b>
            </div>
            <div className="perf-kv">
              <span>Frame p95 / p99</span>
              <b>
                {metrics.p95FrameTime}ms / {metrics.p99FrameTime}ms
              </b>
            </div>
            <div className="perf-kv">
              <span>Dropped / Severe</span>
              <b>
                {metrics.droppedFrames} ({metrics.jankPercent}%) / {metrics.severeJankFrames}
              </b>
            </div>
            <div className="perf-kv">
              <span>Long Tasks / TBT</span>
              <b>
                {metrics.longTaskSupported
                  ? `${metrics.longTaskCount} (${metrics.totalBlockingTimeMs}ms)`
                  : 'N/A (browser)'}
              </b>
            </div>
            <div className="perf-kv">
              <span>JS Heap</span>
              <b>{metrics.jsHeapUsedMb !== null ? `${metrics.jsHeapUsedMb} MB` : 'N/A'}</b>
            </div>
            <div className="perf-kv">
              <span>Device Hints</span>
              <b>
                {metrics.deviceHints.hardwareConcurrency ?? '?'}c ·{' '}
                {metrics.deviceHints.deviceMemoryGb ?? '?'}GB ·{' '}
                {metrics.deviceHints.devicePixelRatio}x
              </b>
            </div>
          </div>

          <div className="perf-hud-section">
            <div className="perf-hud-label">
              <span>
                Adaptive Tier {isDegraded ? '(degraded)' : ''}
                {isManualOverride ? ' · manual' : ' · auto'}
              </span>
              <button
                type="button"
                className="perf-mini-btn"
                onClick={() => perfMonitor.reset()}
              >
                Reset Counters
              </button>
            </div>
            <div className="perf-tier-row">
              <button
                type="button"
                className={'perf-mini-btn' + (!isManualOverride ? ' is-active' : '')}
                onClick={resetToAuto}
              >
                Auto
              </button>
              {QUALITY_TIERS.map((tier: QualityTier) => (
                <button
                  key={tier}
                  type="button"
                  className={
                    'perf-mini-btn' +
                    (isManualOverride && qualityTier === tier ? ' is-active' : '')
                  }
                  onClick={() => setManualTier(tier)}
                >
                  {tier}
                </button>
              ))}
            </div>
          </div>

          <div className="perf-hud-section">
            <div className="perf-hud-label">
              <span>A/B Benchmark</span>
              {report && (
                <span className="perf-score">
                  {report.assessment.costRating} ({report.assessment.score}/100)
                </span>
              )}
            </div>
            <div className="perf-tier-row">
              <button
                type="button"
                className={
                  'perf-mini-btn' +
                  (benchState === 'recording-baseline' ? ' is-recording' : '')
                }
                disabled={benchState === 'recording-active'}
                onClick={toggleBaseline}
              >
                {benchState === 'recording-baseline'
                  ? 'Stop Baseline'
                  : hasBaseline
                    ? 'Re-record Base'
                    : 'Record Base'}
              </button>
              <button
                type="button"
                className={
                  'perf-mini-btn' +
                  (benchState === 'recording-active' ? ' is-recording' : '')
                }
                disabled={benchState === 'recording-baseline'}
                onClick={toggleActive}
              >
                {benchState === 'recording-active'
                  ? 'Stop Active'
                  : hasActive
                    ? 'Re-record Active'
                    : 'Record Active'}
              </button>
              {report && (
                <button type="button" className="perf-mini-btn" onClick={copyReport}>
                  {copied ? 'Copied!' : 'Copy JSON'}
                </button>
              )}
              {(hasBaseline || hasActive) && benchState === 'idle' && (
                <button type="button" className="perf-mini-btn" onClick={resetBench}>
                  Clear
                </button>
              )}
            </div>
            {report && (
              <div className="perf-ab-summary">
                ΔFPS: <b>{report.delta.fpsDelta > 0 ? `+${report.delta.fpsDelta}` : report.delta.fpsDelta}</b> ·
                ΔFrame: <b>{report.delta.frameTimeDeltaMs > 0 ? `+${report.delta.frameTimeDeltaMs}` : report.delta.frameTimeDeltaMs}ms</b> ·
                ΔJank: <b>{report.delta.jankIncreasePercent > 0 ? `+${report.delta.jankIncreasePercent}` : report.delta.jankIncreasePercent}%</b> ·
                ΔTBT: <b>{report.delta.mainThreadBlockingDeltaMs > 0 ? `+${report.delta.mainThreadBlockingDeltaMs}` : report.delta.mainThreadBlockingDeltaMs}ms</b>
              </div>
            )}
          </div>
        </div>
      )}
    </aside>
  )
}
