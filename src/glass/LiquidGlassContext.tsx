import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import type { LiquidGlassGlobalConfig } from './types'

let globalStoreConfig: LiquidGlassGlobalConfig | undefined
const listeners = new Set<() => void>()

function subscribeGlobalConfig(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getGlobalConfigSnapshot(): LiquidGlassGlobalConfig | undefined {
  return globalStoreConfig
}

/**
 * Opt-in, zero-nesting global configuration for all `<LiquidGlass />` instances in the app.
 * Call once at app startup (e.g. in `main.tsx`) without needing any `<LiquidGlassProvider>` wrapper.
 * By default merges with existing global config; pass `{ replace: true }` to overwrite it.
 */
export function configureLiquidGlass(
  config: LiquidGlassGlobalConfig,
  options?: { replace?: boolean },
): void {
  globalStoreConfig = options?.replace ? { ...config } : { ...globalStoreConfig, ...config }
  listeners.forEach((listener) => listener())
}

/** Clears any global configuration previously set via `configureLiquidGlass()`. */
export function resetLiquidGlassConfig(): void {
  globalStoreConfig = undefined
  listeners.forEach((listener) => listener())
}

/** Returns the current module-level global configuration set by `configureLiquidGlass()`. */
export function getLiquidGlassConfig(): LiquidGlassGlobalConfig | undefined {
  return globalStoreConfig
}

const LiquidGlassContext = createContext<LiquidGlassGlobalConfig | undefined>(undefined)

export interface LiquidGlassProviderProps {
  /** Global options applied to descendant `<LiquidGlass />` instances (alias of `config`). */
  value?: LiquidGlassGlobalConfig
  /** Global options applied to descendant `<LiquidGlass />` instances. */
  config?: LiquidGlassGlobalConfig
  /**
   * When nested inside another `<LiquidGlassProvider>`, merge with the parent config by default.
   * Set to `false` to replace the parent config completely.
   */
  inherit?: boolean
  children?: ReactNode
}

/**
 * Optional React Context provider for scoping `<LiquidGlass />` configuration to a specific subtree.
 * Not required — use `configureLiquidGlass()` for app-wide defaults without wrapping components.
 */
export function LiquidGlassProvider({
  value,
  config,
  inherit = true,
  children,
}: LiquidGlassProviderProps) {
  const parentConfig = useContext(LiquidGlassContext)
  const localConfig = value ?? config

  const mergedConfig = useMemo<LiquidGlassGlobalConfig | undefined>(() => {
    if (!inherit || !parentConfig) return localConfig
    if (!localConfig) return parentConfig
    return { ...parentConfig, ...localConfig }
  }, [inherit, parentConfig, localConfig])

  return <LiquidGlassContext.Provider value={mergedConfig}>{children}</LiquidGlassContext.Provider>
}

/**
 * Returns the active global `<LiquidGlass />` configuration for the current tree
 * (merging `configureLiquidGlass()` with any enclosing `<LiquidGlassProvider>`),
 * or `undefined` when neither is used.
 */
export function useLiquidGlassConfig(): LiquidGlassGlobalConfig | undefined {
  const storeConfig = useSyncExternalStore(
    subscribeGlobalConfig,
    getGlobalConfigSnapshot,
    getGlobalConfigSnapshot,
  )
  const contextConfig = useContext(LiquidGlassContext)

  return useMemo<LiquidGlassGlobalConfig | undefined>(() => {
    if (!storeConfig && !contextConfig) return undefined
    if (!storeConfig) return contextConfig
    if (!contextConfig) return storeConfig
    return { ...storeConfig, ...contextConfig }
  }, [storeConfig, contextConfig])
}
