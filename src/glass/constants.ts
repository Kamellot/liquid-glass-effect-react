export const DEFAULT_LENS_SIZE = 166

export const DEFAULT_GLASS_CONFIG = {
  refraction: 70,
  depth: 30,
  dispersion: 20,
  frost: 6,
  splay: 20,
  lightMode: 'natural' as const,
  lightAngle: 0,
  lightIntensity: 40,
  glow: 28,
}

export const DEFAULTS = DEFAULT_GLASS_CONFIG

export const OPTICAL_MATERIAL_DEFAULTS = {
  fill: '#101010',
  fillOverlay: 'rgb(255 255 255 / 0.04)',
  shadow: [
    '-1.25px 0 0 -0.75px #d0d0d0',
    '1.25px 0 0 -0.75px #d0d0d0',
    '0 -1.25px 0 -0.75px rgb(255 255 255 / 0.35)',
    '0 1.25px 0 -0.75px rgb(0 0 0 / 0.35)',
  ].join(', '),
} as const

/** Superellipse corner exponent (2 = circular arc, >2 = continuous-curvature squircle). */
export const SQUIRCLE_EXPONENT = 2.8

export const MAX_BITMAP_CACHE = 40
export const MAX_ASSET_CACHE = 40
export const MAX_BEVEL_BUDGET = 72_000
export const MAX_WEBGL_PIXEL_BUDGET = 140_000
export const MIN_WEBGL_SCALE = 0.4
export const MAX_RENDER_DPR = 2

export const BEVEL_MIN_DEPTH = 0.5
export const BEVEL_OUTER_AA_PX = 0.75
export const BEVEL_REFRACTION_FACTOR = 1.5
export const DISPERSION_MAX_SPREAD = 0.36
export const NEUTRAL_DISPLACEMENT_CHANNEL = 128

export const FROST_BLUR_SCALE = 0.2
export const FROST_SATURATION_SCALE = 0.8
export const FROST_MIN_THRESHOLD = 0.05
export const REFRACTION_MIN_THRESHOLD = 0.01
export const LIGHT_INTENSITY_MIN_THRESHOLD = 0.05
export const GLOW_MIN_THRESHOLD = 0.05

/** Scales down dynamic refraction/dispersion when OS reduced-motion preference is active. */
export const REDUCED_MOTION_DISPLACEMENT_SCALE = 0.25

export const OFFSCREEN_MARGIN_PX = 200
export const INTERSECTION_ROOT_MARGIN = '150px'
export const SNAPSHOT_ROOT_MARGIN = '200px'
export const DRAW_FRAME_BUDGET_MS = 5
export const DRAW_BATCH_MIN_OPS = 4
export const TRANSITION_LOOP_DURATION_MS = 450
export const OFFSET_EPSILON_PX = 0.25

export const MAX_SNAP_DIM = 2200
export const MAX_VIDEO_SNAP_DIM = 960
export const MIN_VIDEO_CAPTURE_INTERVAL_MS = 32
export const OVERLAP_MARGIN_PX = 64
export const SCOPE_RECT_CACHE_TTL_MS = 12
export const MAX_SORTED_CONSUMERS = 16

export const WEBGL_PYRAMID_LEVELS = 5
