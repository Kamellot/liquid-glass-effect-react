import type { HTMLAttributes, ReactNode, RefObject } from 'react'

export type LiquidGlassMode = 'layer' | 'wrapper'
export type LiquidGlassLightMode = 'natural' | 'custom'

export type LiquidGlassOptions = {
  size?: number
  refraction?: number
  depth?: number
  dispersion?: number
  frost?: number
  splay?: number
  lightMode?: LiquidGlassLightMode
  lightAngle?: number
  lightIntensity?: number
  glow?: number
  borderRadius?: number | string
  tint?: string
  fill?: string | boolean
  fillOverlay?: string
  shadow?: string | boolean
}

export type LiquidGlassGlobalConfig = LiquidGlassOptions

export type DisplacementMapInfo = {
  fieldId: string | null
  dataUrl: string | null
  width: number
  height: number
  borderRadius: number
  hash: string
}

export type LiquidGlassProps = LiquidGlassOptions &
  Omit<HTMLAttributes<HTMLDivElement>, 'color'> & {
    mode?: LiquidGlassMode
    ignoreGlobal?: boolean
    refractionTarget?: RefObject<HTMLElement | null> | HTMLElement | null
    onMapUpdate?: (info: DisplacementMapInfo) => void
    [dataAttr: `data-${string}`]: unknown
  }

export type LiquidGlassProviderProps = {
  value?: LiquidGlassGlobalConfig
  config?: LiquidGlassGlobalConfig
  inherit?: boolean
  children?: ReactNode
}

export type DisplacementMapSpec = {
  width: number
  height: number
  borderRadius: number
  depth: number
  splay: number
}

export type BevelSpec = DisplacementMapSpec & { scale: number }

export type BevelField = {
  fieldId: string
  hash: string
  width: number
  height: number
  hw: number
  hh: number
  bx: number
  by: number
  borderRadius: number
  effectiveDepth: number
  splayExp: number
  cornerExponent: number
  splay: number
  scale: number
  bufWidth: number
  bufHeight: number
  count: number
  indices: Uint32Array
  px: Uint16Array
  py: Uint16Array
  vecX: Float32Array
  vecY: Float32Array
  alpha: Uint8Array
  cpuReady: boolean
}

export type AcquiredBevel = { field: BevelField; dataUrl: string }

export type EngineStats = {
  fields: number
  consumers: number
  bitmaps: number
  snapshots: number
}

export type TargetSnapshot = {
  readonly data: Uint8ClampedArray
  canvas: HTMLCanvasElement
  version: number
  width: number
  height: number
  scale: number
  cssWidth: number
  cssHeight: number
}
