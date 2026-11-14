import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { LiquidGlassGlobalConfig } from './types'

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
  children: ReactNode
}

/**
 * Opt-in provider for sharing global `<LiquidGlass />` configuration across a React subtree.
 * Individual `<LiquidGlass />` instances automatically override any global option with their own
 * props, or can pass `ignoreGlobal` to skip global settings altogether.
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

/** Returns the active `<LiquidGlassProvider>` configuration, or `undefined` when none is mounted. */
export function useLiquidGlassConfig(): LiquidGlassGlobalConfig | undefined {
  return useContext(LiquidGlassContext)
}
