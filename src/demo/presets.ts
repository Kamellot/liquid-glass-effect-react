import { DEFAULT_LENS_SIZE, DEFAULTS } from '../glass'

export interface DemoParams {
  size: number
  chroma: number
  depth: number
  blur: number
  edgeHighlight: number
  strength: number
  curvature: number
  splay: number
  glow: number
  specularAngle: number
}

export const DEFAULT_PARAMS: DemoParams = {
  size: DEFAULT_LENS_SIZE,
  ...DEFAULTS,
}

export interface SliderDef {
  key: keyof DemoParams
  label: string
  min: number
  max: number
  step: number
  decimals: number
}

/** Exact 10-slider reading order: left column (5), then right column (5). */
export const SLIDERS: SliderDef[] = [
  { key: 'size', label: 'Size', min: 40, max: 360, step: 1, decimals: 0 },
  { key: 'chroma', label: 'Chroma', min: 0, max: 1, step: 0.01, decimals: 2 },
  { key: 'depth', label: 'Depth', min: 1, max: 50, step: 1, decimals: 0 },
  { key: 'blur', label: 'Blur', min: 0, max: 20, step: 0.1, decimals: 1 },
  { key: 'edgeHighlight', label: 'Edge Highlight', min: 0, max: 1, step: 0.01, decimals: 2 },
  { key: 'strength', label: 'Strength', min: 0, max: 0.2, step: 0.001, decimals: 3 },
  { key: 'curvature', label: 'Curvature', min: 0, max: 1, step: 0.01, decimals: 2 },
  { key: 'splay', label: 'Splay', min: 0, max: 1, step: 0.01, decimals: 2 },
  { key: 'glow', label: 'Glow', min: 0, max: 1, step: 0.01, decimals: 2 },
  { key: 'specularAngle', label: 'Specular Angle', min: 0, max: 360, step: 1, decimals: 0 },
]

export interface Preset {
  name: string
  params: Partial<DemoParams>
}

export const PRESETS: Preset[] = [
  { name: 'Default', params: DEFAULT_PARAMS },
  {
    name: 'Pure Water Lens',
    params: {
      size: 220,
      strength: 0.11,
      curvature: 0.92,
      depth: 11,
      splay: 0.82,
      chroma: 0,
      blur: 0,
      edgeHighlight: 0.55,
      glow: 0.45,
      specularAngle: 71,
    },
  },
  {
    name: 'Apple iOS Dock',
    params: {
      size: 166,
      strength: 0.05,
      curvature: 0.85,
      depth: 6,
      splay: 0.7,
      chroma: 0.25,
      blur: 5,
      edgeHighlight: 1,
      glow: 0.85,
      specularAngle: 71,
    },
  },
  {
    name: 'Chromatic Prism',
    params: {
      size: 200,
      strength: 0.15,
      curvature: 1,
      depth: 16,
      splay: 0.92,
      chroma: 1,
      blur: 0,
      edgeHighlight: 1,
      glow: 0.7,
      specularAngle: 135,
    },
  },
  {
    name: 'Frosted Pebble',
    params: {
      size: 190,
      strength: 0.06,
      curvature: 0.6,
      depth: 24,
      splay: 0.5,
      chroma: 0.15,
      blur: 12,
      edgeHighlight: 0.8,
      glow: 0.9,
      specularAngle: 250,
    },
  },
]

