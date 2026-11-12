import type { CSSProperties, ReactNode } from 'react'

/** auto = SVG backdrop-filter where supported, else WebGL (inside a <GlassScene>), else CSS ring. */
export type GlassEngine = 'auto' | 'svg' | 'webgl' | 'fallback'

/** Optical parameters shared by the component, the map generator and the filter registry. */
export interface OpticalParams {
  /** Refraction intensity, 0–0.2. Becomes the `scale` of `feDisplacementMap`. */
  strength: number
  /** Lens surface profile, 0–1. Higher = squarer (more "squircle") bevel. */
  curvature: number
  /** Bevel thickness, 1–50 (scaled relative to the element's size). */
  depth: number
  /** Falloff spread of the edge normals, 0–1. */
  splay: number
  /** Chromatic aberration, 0–1. 0 disables the 3-channel split entirely. */
  chroma: number
  /** Frosted blur in px, 0–20. */
  blur: number
}

export interface LightingParams {
  /** Crisp 1px rim highlight intensity, 0–1. */
  edgeHighlight: number
  /** Inner specular glow intensity, 0–1. */
  glow: number
  /** Light direction in degrees (0 = top, clockwise). */
  specularAngle: number
}

export interface LiquidGlassProps extends Partial<OpticalParams>, Partial<LightingParams> {
  /**
   * Standalone circular lens diameter in px. When omitted the component measures
   * its parent (layer mode) / itself (wrapper mode) with a ResizeObserver.
   */
  size?: number
  /**
   * `layer`  – aria-hidden material node, absolutely fills the parent (default).
   * `wrapper` – container element that renders `children` above the glass.
   */
  mode?: 'layer' | 'wrapper'
  /** Override the corner radius (px or any CSS length). Defaults to the inherited radius. */
  borderRadius?: number | string
  /** Force a rendering path. `auto` = feature + engine detection. */
  engine?: GlassEngine
  className?: string
  style?: CSSProperties
  children?: ReactNode
}

export const DEFAULTS = {
  strength: 0.08,
  curvature: 0.99,
  depth: 4,
  splay: 0.76,
  chroma: 1,
  blur: 0,
  edgeHighlight: 1,
  glow: 1,
  specularAngle: 71,
} as const

