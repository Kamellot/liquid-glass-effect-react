import { DEFAULT_LENS_SIZE, DEFAULTS, type LiquidGlassLightMode } from '../glass'

export interface DemoParams {
  size: number
  refraction: number
  depth: number
  dispersion: number
  frost: number
  splay: number
  magnification: number
  lightMode: LiquidGlassLightMode
  lightAngle: number
  lightIntensity: number
  glow: number
}

export const DEFAULT_PARAMS: DemoParams = {
  size: DEFAULT_LENS_SIZE,
  ...DEFAULTS,
}

export interface SliderDef {
  key: Exclude<keyof DemoParams, 'lightMode'>
  label: string
  min: number
  max: number
  step: number
  decimals: number
}

/** Reading order: left column (4), then right column (4). Optical sliders use a normalized 0–100 scale. */
export const SLIDERS: SliderDef[] = [
  { key: 'size', label: 'Size', min: 40, max: 360, step: 1, decimals: 0 },
  { key: 'refraction', label: 'Refraction', min: 0, max: 100, step: 1, decimals: 0 },
  { key: 'depth', label: 'Depth', min: 0, max: 100, step: 1, decimals: 0 },
  { key: 'dispersion', label: 'Dispersion', min: 0, max: 100, step: 1, decimals: 0 },
  { key: 'frost', label: 'Frost', min: 0, max: 100, step: 1, decimals: 0 },
  { key: 'splay', label: 'Splay', min: 0, max: 100, step: 1, decimals: 0 },
  { key: 'magnification', label: 'Magnification', min: 0.4, max: 2, step: 0.05, decimals: 2 },
  { key: 'lightAngle', label: 'Light Angle', min: 0, max: 360, step: 1, decimals: 0 },
  { key: 'lightIntensity', label: 'Light Intensity', min: 0, max: 100, step: 1, decimals: 0 },
  { key: 'glow', label: 'Glow', min: 0, max: 100, step: 1, decimals: 0 },
]

export interface Preset {
  name: string
  params: Partial<DemoParams>
}

export const PRESETS: Preset[] = [
  { name: 'Default', params: DEFAULT_PARAMS },
  {
    name: 'Crystal Lens',
    params: { size: 220, refraction: 55, depth: 30, dispersion: 0, frost: 0, splay: 40, magnification: 1, lightAngle: 0, lightIntensity: 25, glow: 20 },
  },
  {
    name: 'Floating Dock',
    params: { size: 166, refraction: 45, depth: 14, dispersion: 10, frost: 14, splay: 30, magnification: 1, lightAngle: 0, lightIntensity: 50, glow: 35 },
  },
  {
    name: 'Chromatic Prism',
    params: { size: 200, refraction: 90, depth: 34, dispersion: 80, frost: 0, splay: 10, magnification: 1, lightAngle: 135, lightIntensity: 60, glow: 65 },
  },
  {
    name: 'Frosted Card',
    params: { size: 190, refraction: 35, depth: 40, dispersion: 10, frost: 55, splay: 60, magnification: 1, lightAngle: 250, lightIntensity: 40, glow: 45 },
  },
]
