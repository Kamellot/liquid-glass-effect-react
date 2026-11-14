import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { AdaptiveQualityController } from './AdaptiveQualityController'
import { perfMonitor } from './PerfEngine'
import type {
  AdaptiveQualityOptions,
  PerfEngineLike,
  PerfSnapshot,
  QualityTier,
  UseAdaptiveQualityResult,
} from './types'

/**
 * React hook wrapping AdaptiveQualityController with SSR-safe external store
 * synchronization and automatic telemetry lifecycle management.
 */
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

  const [controllerEntry, setControllerEntry] = useState(() => ({
    engine: targetEngine,
    controller: new AdaptiveQualityController(options),
  }))

  if (controllerEntry.engine !== targetEngine) {
    setControllerEntry({
      engine: targetEngine,
      controller: new AdaptiveQualityController(options),
    })
  }

  const { controller } = controllerEntry

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
  const getSnapshot = useCallback(() => controller.getSnapshot(), [controller])
  const getServerSnapshot = useCallback(
    () => controller.getServerSnapshot(),
    [controller],
  )

  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  const setManualTier = useCallback(
    (tier: QualityTier | null) => controller.setManualTier(tier),
    [controller],
  )

  const resetToAuto = useCallback(
    () => controller.resetToAuto(),
    [controller],
  )

  return {
    ...state,
    setManualTier,
    resetToAuto,
  }
}

/**
 * Lightweight React hook subscribing directly to a PerfEngine telemetry snapshot.
 */
export function usePerfMetrics(
  engine: PerfEngineLike = perfMonitor,
  enabled = true,
): PerfSnapshot {
  const [serverSnapshot] = useState(() => engine.getSnapshot())

  useEffect(() => {
    if (!enabled) return undefined
    return engine.acquire()
  }, [engine, enabled])

  const subscribe = useCallback(
    (onStoreChange: () => void) => engine.subscribe(onStoreChange),
    [engine],
  )
  const getSnapshot = useCallback(() => engine.getSnapshot(), [engine])
  const getServerSnapshot = useCallback(() => serverSnapshot, [serverSnapshot])

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
