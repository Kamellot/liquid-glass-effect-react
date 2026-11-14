import type { HTMLAttributes, RefObject } from 'react'

/**
 * Optical and geometric parameters for `<LiquidGlass />`.
 * All optical values use a normalized 0–100 scale.
 */
export interface LiquidGlassOptions {
  /** Explicit square diameter (px) for standalone lenses; omitted when auto-measuring parent or content. */
  size?: number
  /** Strength of edge light bending (0–100, default 70). Scales the rim pull distance. */
  refraction?: number
  /** Physical bevel/rim width in px measured from the outer edge inward (0–100, default 30). */
  depth?: number
  /** Chromatic dispersion: RGB channel separation confined to the curved bevel (0–100, default 20). */
  dispersion?: number
  /** Frosted surface diffusion: blur plus a subtle saturation boost (0–100, default 6). */
  frost?: number
  /** Falloff smoothness: how gently the bent rim eases into the flat center (0–100, default 20). */
  splay?: number
  /** Lighting mode: 'natural' (top & bottom white border glow) or 'custom' (directional angle, intensity, glow). */
  lightMode?: LiquidGlassLightMode
  /** Light source direction in degrees for 'custom' mode, 0 = top (0–360, default 0). */
  lightAngle?: number
  /** Brightness of the specular rim (0–100, default 40). */
  lightIntensity?: number
  /** Natural white inner glow / volumetric specular bloom (0–100, default 28). */
  glow?: number
  /**
   * Corner radius. Number = px, string = any CSS radius (`'24px'`, `'50%'`).
   * Omit to inherit the parent's radius.
   */
  borderRadius?: number | string
  /** Optional UI background color/tint fill applied seamlessly across interior and refracted bevel. */
  tint?: string
  /**
   * Base surface fill color for Fill + Shadow mode (e.g. `'#101010'`, `'rgb(30 64 175 / 0.75)'`),
   * or `true` to use the default `#101010` optical material fill.
   */
  fill?: string | boolean
  /**
   * Top surface sheen layered over `fill` (default: `'rgb(255 255 255 / 0.04)'`).
   * Set to `'none'` or `'transparent'` to disable.
   */
  fillOverlay?: string
  /**
   * Edge/drop shadows for Fill + Shadow mode.
   * `true` (or omitted when `fill` is set) uses the default directional edge shadows;
   * pass a custom CSS `box-shadow` string to customize, or `false` / `'none'` to disable.
   */
  shadow?: string | boolean
}

export type LiquidGlassMode = 'layer' | 'wrapper'
export type LiquidGlassLightMode = 'natural' | 'custom'
export type LiquidGlassGlobalConfig = LiquidGlassOptions

export interface DisplacementMapInfo {
  /** Shared cached bevel field revision identifier (e.g. `lg-b1`), or `null` when refraction is 0. */
  fieldId: string | null
  dataUrl: string | null
  width: number
  height: number
  borderRadius: number
  hash: string
}

export interface LiquidGlassProps
  extends LiquidGlassOptions,
    Omit<HTMLAttributes<HTMLDivElement>, 'color'> {
  /** Integration pattern: optical material `'layer'` (default) or `'wrapper'`. */
  mode?: LiquidGlassMode
  /** Skip `<LiquidGlassProvider>` global configuration for this instance and use local props + built-in defaults only. */
  ignoreGlobal?: boolean
  /** Target layer element/ref for cross-browser Canvas/WebGL SDF refraction. */
  refractionTarget?: RefObject<HTMLElement | null> | HTMLElement | null
  /** Callback invoked when the displacement map or bevel field updates (useful for debug previews). */
  onMapUpdate?: (info: DisplacementMapInfo) => void
  /** Allow arbitrary `data-*` attributes on `createElement` as well as JSX. */
  [dataAttr: `data-${string}`]: unknown
}
