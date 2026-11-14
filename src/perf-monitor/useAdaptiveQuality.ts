import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { AdaptiveQualityController } from './AdaptiveQualityController'
import { perfMonitor } from './PerfEngine'
import type {
  AdaptiveQualityOptions,
  PerfEngineLike,
  PerfSnapshot,
  QualityTier,
  UseAdaptiveQualityResult,
} from './types'

export function useAdaptiveQuality(
  options: AdaptiveQualityOptions = {},
): UseAdaptiveQualityResult {
  const {
    minFpsThreshold,
    autoDowngrade,
    downgradeDelayMs,
    cooldownMs,
    evaluationWindowMs,
    minSampleFrames,
    initialTier,
    autoRecover,
    recoveryFpsThreshold,
    recoveryDelayMs,
    respectReducedMotion,
    engine,
    enabled = true,
  } = options

  const targetEngine = engine ?? perfMonitor
  const initialOptionsRef = useRef(options)
  initialOptionsRef.current = options

  const controller = useMemo(
    () => new AdaptiveQualityController({ ...initialOptionsRef.current, engine: targetEngine }),
    [targetEngine],
  )

  useEffect(() => {
    controller.updateOptions({
      minFpsThreshold,
      autoDowngrade,
      downgradeDelayMs,
      cooldownMs,
      evaluationWindowMs,
      minSampleFrames,
      initialTier,
      autoRecover,
      recoveryFpsThreshold,
      recoveryDelayMs,
      respectReducedMotion,
    })
  }, [
    controller,
    minFpsThreshold,
    autoDowngrade,
    downgradeDelayMs,
    cooldownMs,
    evaluationWindowMs,
    minSampleFrames,
    initialTier,
    autoRecover,
    recoveryFpsThreshold,
    recoveryDelayMs,
    respectReducedMotion,
  ])

  useEffect(() => {
    if (!enabled) return undefined
    return controller.connect()
  }, [controller, enabled])

  const subscribe = useCallback(
    (onStoreChange: () => void) => controller.subscribe(onStoreChange),
    [controller],
  )

  const state = useSyncExternalStore(
    subscribe,
    () => controller.getSnapshot(),
    () => controller.getServerSnapshot(),
  )

  const setManualTier = useCallback(
    (tier: QualityTier | null) => controller.setManualTier(tier),
    [controller],
  )

  const resetToAuto = useCallback(() => controller.resetToAuto(), [controller])

  return {
    ...state,
    setManualTier,
    resetToAuto,
  }
}

export function usePerfMetrics(
  engine: PerfEngineLike = perfMonitor,
  enabled = true,
): PerfSnapshot {
  const [fallbackServerSnapshot] = useState(() => engine.getServerSnapshot?.() ?? engine.getSnapshot())

  useEffect(() => {
    if (!enabled) return undefined
    return engine.acquire()
  }, [engine, enabled])

  const subscribe = useCallback(
    (onStoreChange: () => void) => engine.subscribe(onStoreChange),
    [engine],
  )

  return useSyncExternalStore(
    subscribe,
    () => engine.getSnapshot(),
    () => engine.getServerSnapshot?.() ?? fallbackServerSnapshot,
  )
}
