/**
 * Optical model shared by the SVG displacement-map generator and the WebGL shader,
 * so every rendering engine bends light the same way.
 */

export const IOR = 1.5
/** Peak displacement in px = strength × min(w, h) × STRENGTH_GAIN. */
export const STRENGTH_GAIN = 1
/** Relative R/B displacement spread at chroma = 1. */
export const CHROMA_SPREAD = 0.045
/** Numerical floor — identical in JS and GLSL (mediump-safe). */
export const EPS = 1e-4

const PEAK_SAMPLES = 256

/** Bevel thickness in px. `depth` 1…50 maps onto ~15 %…100 % of the half-extent. */
export function bevelWidth(width: number, height: number, depth: number): number {
  const half = Math.min(width, height) / 2
  const t = Math.min(1, Math.max(0, depth / 50))
  return Math.max(2, Math.min(half, half * (0.04 + 0.96 * Math.sqrt(t))))
}

/** Squircle exponent of the convex bevel profile. */
export const profileExponent = (curvature: number) => 1 + curvature * 3
/** t' = t^spread — a larger `splay` makes the effect reach deeper into the surface. */
export const profileSpread = (splay: number) => 1 + splay

/**
 * Un-normalised lateral ray offset at bevel position t (0 = rim, 1 = interior):
 * height h(t) = (1 − (1 − t')^n)^(1/n); its slope gives the incidence angle and
 * Snell's law (IOR 1.5) the refraction offset.
 */
export function rawMagnitude(t: number, n: number, spread: number): number {
  const tp = Math.pow(Math.max(t, EPS), spread)
  const inv = 1 - tp
  const base = Math.max(EPS, 1 - Math.pow(inv, n))
  const slope = Math.pow(base, 1 / n - 1) * Math.pow(Math.max(inv, EPS), n - 1)
  const theta = Math.atan(slope)
  const thetaR = Math.asin(Math.sin(theta) / IOR)
  return Math.tan(theta - thetaR)
}

/** Smooth landing on the flat interior. */
export const bevelFade = (t: number) => (t > 0.85 ? Math.max(0, (1 - t) / 0.15) : 1)

/** Maximum of `rawMagnitude` — used to normalise the profile to 1 at the rim. */
export function profilePeak(n: number, spread: number): number {
  let peak = 0
  for (let i = 0; i < PEAK_SAMPLES; i++) peak = Math.max(peak, rawMagnitude(i / (PEAK_SAMPLES - 1), n, spread))
  return peak
}

