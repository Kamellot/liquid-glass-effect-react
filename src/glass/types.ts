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

export const DEFAULTS: Required<Omit<LiquidGlassOptions, 'size' | 'tint' | 'borderRadius'>> = {
  refraction: 70,
  depth: 30,
  dispersion: 20,
  frost: 6,
  splay: 20,
  lightAngle: 0,
  lightIntensity: 40,
}
