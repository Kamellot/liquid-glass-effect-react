import type { OpticalParams } from './types'

/**
 * Offscreen SDF → displacement-map generator.
 *
 *  1. A signed-distance field of a rounded rectangle (a circle is the r = min/2 case)
 *     gives, per pixel, the distance `d` from the rim and the outward surface normal.
 *  2. The bevel is modelled as a convex "squircle" height profile
 *        h(t) = (1 − (1 − t)^n)^(1/n),   t = d / bevel ∈ [0,1]
 *     where `n` grows with `curvature`. Its slope gives the local incidence angle,
 *     and Snell's law (glass IOR ≈ 1.5) turns that into a lateral ray offset.
 *  3. `splay` widens/narrows how far that offset reaches into the surface.
 *  4. The offset is encoded along the *inward* normal: X → red, Y → green,
 *     128 = neutral. The magnitude is normalised to 1 at the rim; the actual pixel
 *     amount (`strength`) is applied later through the `scale` of feDisplacementMap,
 *     so the same bitmap serves every strength / chroma / blur variation.
 */

export interface MapGeometry {
  width: number
  height: number
  radius: number
}

export interface GeneratedMap {
  url: string
  /** Bevel thickness in CSS px for this geometry + depth. */
  bevel: number
}

type MapParams = Pick<OpticalParams, 'depth' | 'curvature' | 'splay'>

const MAX_MAP_PIXELS = 360_000
const LUT_SIZE = 256
const IOR = 1.5

const cache = new Map<string, GeneratedMap>()
const CACHE_LIMIT = 48

/** Bevel thickness in px. `depth` 1…50 maps onto 15 %…100 % of the half-extent. */
export function bevelWidth(width: number, height: number, depth: number): number {
  const half = Math.min(width, height) / 2
  const t = Math.min(1, Math.max(0, depth / 50))
  return Math.max(2, Math.min(half, half * (0.04 + 0.96 * Math.sqrt(t))))
}

export function mapCacheKey(g: MapGeometry, p: MapParams): string {
  return [g.width, g.height, g.radius.toFixed(1), p.depth.toFixed(1), p.curvature.toFixed(2), p.splay.toFixed(2)].join('_')
}

/** Normalised (peak = 1) refraction magnitude along the bevel, t = 0 (rim) … 1 (interior). */
function buildProfile(curvature: number, splay: number): Float32Array {
  const n = 1 + curvature * 3
  const spread = 1 + splay // t' = t^spread : bigger splay ⇒ effect reaches deeper
  const lut = new Float32Array(LUT_SIZE)
  let peak = 0
  for (let i = 0; i < LUT_SIZE; i++) {
    const t = Math.pow(i / (LUT_SIZE - 1), spread)
    const inv = 1 - t
    const base = Math.max(1e-6, 1 - Math.pow(inv, n))
    const slope = Math.pow(base, 1 / n - 1) * Math.pow(inv, n - 1)
    const theta = Math.atan(slope)
    const thetaR = Math.asin(Math.sin(theta) / IOR)
    const m = Math.tan(theta - thetaR)
    lut[i] = m
    if (m > peak) peak = m
  }
  for (let i = 0; i < LUT_SIZE; i++) lut[i] = peak > 0 ? lut[i] / peak : 0
  // Guarantee a smooth landing on the flat interior.
  for (let i = 0; i < LUT_SIZE; i++) {
    const u = i / (LUT_SIZE - 1)
    lut[i] *= u > 0.85 ? Math.max(0, (1 - u) / 0.15) : 1
  }
  return lut
}

export function generateDisplacementMap(g: MapGeometry, p: MapParams): GeneratedMap {
  const key = mapCacheKey(g, p)
  const hit = cache.get(key)
  if (hit) {
    cache.delete(key)
    cache.set(key, hit) // LRU refresh
    return hit
  }

  const bevelCss = bevelWidth(g.width, g.height, p.depth)
  const down = Math.min(1, Math.sqrt(MAX_MAP_PIXELS / (g.width * g.height)))
  const W = Math.max(2, Math.round(g.width * down))
  const H = Math.max(2, Math.round(g.height * down))
  const sx = W / g.width
  const sy = H / g.height
  const s = Math.min(sx, sy)
  const bevel = bevelCss * s
  const radius = Math.min(g.radius, Math.min(g.width, g.height) / 2) * s

  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d', { willReadFrequently: false })
  if (!ctx) throw new Error('2D canvas unavailable')
  const img = ctx.createImageData(W, H)
  const data = img.data
  const lut = buildProfile(p.curvature, p.splay)

  const hw = W / 2
  const hh = H / 2
  const bx = hw - radius
  const by = hh - radius

  for (let y = 0; y < H; y++) {
    const py = y + 0.5 - hh
    const ay = Math.abs(py)
    const sgy = py < 0 ? -1 : 1
    const qy = ay - by
    for (let x = 0; x < W; x++) {
      const px = x + 0.5 - hw
      const ax = Math.abs(px)
      const sgx = px < 0 ? -1 : 1
      const qx = ax - bx

      // Rounded-rect SDF (negative inside) and outward normal.
      let nx: number
      let ny: number
      let sdf: number
      if (qx > 0 && qy > 0) {
        const len = Math.hypot(qx, qy)
        nx = (qx / len) * sgx
        ny = (qy / len) * sgy
        sdf = len - radius
      } else if (qx > qy) {
        nx = sgx
        ny = 0
        sdf = qx - radius
      } else {
        nx = 0
        ny = sgy
        sdf = qy - radius
      }

      const d = -sdf
      let r = 128
      let gch = 128
      if (d > 0 && d < bevel) {
        const f = (d / bevel) * (LUT_SIZE - 1)
        const i0 = f | 0
        const frac = f - i0
        const m = lut[i0] * (1 - frac) + lut[Math.min(LUT_SIZE - 1, i0 + 1)] * frac
        // inward = −normal. Displacement-map convention: out(p) = in(p + scale·(C − ½)).
        r = 128 - nx * m * 127
        gch = 128 - ny * m * 127
      }
      const o = (y * W + x) * 4
      data[o] = r
      data[o + 1] = gch
      data[o + 2] = 128
      data[o + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)

  const result: GeneratedMap = { url: canvas.toDataURL('image/png'), bevel: bevelCss }
  cache.set(key, result)
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
  return result
}
