import type { CSSProperties, ReactNode, RefObject } from 'react'

/** Optical and geometric parameters for `<LiquidGlass />`. */
export interface LiquidGlassOptions {
  /** Explicit square diameter (px) for standalone lenses; omitted when auto-measuring parent/content. */
  size?: number
  /** Displacement strength multiplier (0.000 to 0.200). */
  strength?: number
  /** Bevel curvature / refractive steepness (0.00 to 1.00). */
  curvature?: number
  /** Bevel thickness inward from the border in pixels (1 to 50). */
  depth?: number
  /** How broadly refraction splays across the bevel depth (0.00 to 1.00). */
  splay?: number
  /** Chromatic RGB dispersion split intensity (0.00 to 1.00). */
  chroma?: number
  /** Hardware-accelerated backdrop blur in pixels (0.0 to 20.0). */
  blur?: number
  /** Specular 1.5px border rim intensity (0.00 to 1.00). */
  edgeHighlight?: number
  /** Directional inner volumetric glow + radial surface sheen (0.00 to 1.00). */
  glow?: number
  /** Specular light source azimuth in degrees (0 to 360). */
  specularAngle?: number
  /** Specular shine style: rotating 'directional' conic/angled highlight or uniform top/bottom 'apple' rim. */
  specularMode?: SpecularMode
}

export type LiquidGlassMode = 'layer' | 'wrapper'

export type SpecularMode = 'directional' | 'apple'

export interface DisplacementMapInfo {
  /** Shared cached bevel field revision identifier (e.g. `lg-b1`), or `null` when strength is 0. */
  fieldId: string | null
  dataUrl: string | null
  width: number
  height: number
  borderRadius: number
  hash: string
}

export interface LiquidGlassProps extends LiquidGlassOptions {
  /** Integration pattern: Apple Material 'layer' (default) or 'wrapper'. */
  mode?: LiquidGlassMode
  /** Target layer element/ref for universal cross-browser Canvas SDF refraction. */
  refractionTarget?: RefObject<HTMLElement | null> | HTMLElement | null
  /** Optional children (used in 'wrapper' mode). */
  children?: ReactNode
  className?: string
  style?: CSSProperties
  /** Callback invoked when the displacement map or bevel field updates (useful for debug previews). */
  onMapUpdate?: (info: DisplacementMapInfo) => void
}

export const DEFAULT_LENS_SIZE = 166

export const DEFAULTS: Required<Omit<LiquidGlassOptions, 'size'>> = {
  strength: 0.08,
  curvature: 0.99,
  depth: 4,
  splay: 0.76,
  chroma: 1.0,
  blur: 0.0,
  edgeHighlight: 1.0,
  glow: 1.0,
  specularAngle: 71,
  specularMode: 'directional',
}
