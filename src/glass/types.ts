import type { CSSProperties, ReactNode, RefObject } from 'react'

/**
 * Optical and geometric parameters for `<LiquidGlass />`.
 * All optical values use the same 0–100 scale as native Apple / Figma "Glass" panels.
 */
export interface LiquidGlassOptions {
  /** Explicit square diameter (px) for standalone lenses; omitted when auto-measuring parent/content. */
  size?: number
  /** Strength of edge light bending (0–100, default 70). Scales the rim pull distance, like feDisplacementMap `scale`. */
  refraction?: number
  /** Physical bevel/rim width in px measured from the outer edge inward (0–100, default 30). */
  depth?: number
  /** Chromatic dispersion: RGB channel separation, confined to the curved bevel (0–100, default 20). */
  dispersion?: number
  /** Frosted surface diffusion: blur plus a subtle saturation boost (0–100, default 6). */
  frost?: number
  /** Falloff smoothness: how gently the bent rim eases into the flat center (0–100, default 20). */
  splay?: number
  /** Light source direction in degrees, 0 = light from the top (0–360, default 0). */
  lightAngle?: number
  /** Brightness of the directional specular rim and subtle inner reflection (0–100, default 40). */
  lightIntensity?: number
  /**
   * Corner radius. Number = px, string = any CSS radius (`'24px'`, `'50%'`).
   * Omit to inherit the parent's radius.
   */
  borderRadius?: number | string
  /** Optional UI background color/tint fill applied seamlessly across interior and refracted bevel. */
  tint?: string
  /**
   * Figma-style `Fill + Shadow` base fill color (e.g. `'#101010'`, `'rgb(30 64 175 / 0.75)'`),
   * or `true` to use Figma's default `#101010` fill.
   */
  fill?: string | boolean
  /**
   * Top surface sheen layered over `fill` (Figma default: `'rgb(255 255 255 / 0.04)'`).
   * Set to `'none'` or `'transparent'` to disable.
   */
  fillOverlay?: string
  /**
   * Figma-style `Fill + Shadow` edge/drop shadows.
   * `true` (or omitted when `fill` is set) uses Figma's default directional edge shadows;
   * pass a custom CSS `box-shadow` string to customize, or `false` / `'none'` to disable.
   */
  shadow?: string | boolean
}

export type LiquidGlassMode = 'layer' | 'wrapper'

export interface DisplacementMapInfo {
  /** Shared cached bevel field revision identifier (e.g. `lg-b1`), or `null` when refraction is 0. */
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

export const FIGMA_MATERIAL_DEFAULTS = {
  fill: '#101010',
  fillOverlay: 'rgb(255 255 255 / 0.04)',
  shadow: [
    '-1.25px 0 0 -0.75px #d0d0d0',
    '1.25px 0 0 -0.75px #d0d0d0',
    '0 -1.25px 0 -0.75px rgb(255 255 255 / 0.35)',
    '0 1.25px 0 -0.75px rgb(0 0 0 / 0.35)',
  ].join(', '),
} as const

export const DEFAULTS: Required<
  Omit<LiquidGlassOptions, 'size' | 'tint' | 'borderRadius' | 'fill' | 'fillOverlay' | 'shadow'>
> = {
  refraction: 70,
  depth: 30,
  dispersion: 20,
  frost: 6,
  splay: 20,
  lightAngle: 0,
  lightIntensity: 40,
}
