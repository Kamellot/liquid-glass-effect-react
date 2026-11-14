import type { TargetSnapshot } from './domSnapshot'
import { getSnapshotCount, subscribeSnapshotStats } from './domSnapshot'
import {
  isWebGLRefractionAvailable,
  parseCssColorRgba,
  renderRefractedBevelWebGL,
} from './webglRefraction'

const MAX_BITMAP_CACHE = 64
const MAX_BEVEL_BUDGET = 72_000

/** Superellipse exponent of the corner distance metric (2 = circle, ∞ = square; 2.8 ≈ continuous-curvature squircle). */
const SQUIRCLE_EXPONENT = 2.8

export interface DisplacementMapSpec {
  width: number
  height: number
  borderRadius: number
  /** Bevel width in px (0–100). */
  depth: number
  /** Falloff smoothness (0–100). */
  splay: number
}

export interface BevelSpec extends DisplacementMapSpec {
  scale: number
}

export interface BevelField {
  fieldId: string
  hash: string
  width: number
  height: number
  borderRadius: number
  effectiveDepth: number
  maxRadialSlope: number
  splayExp: number
  cornerExponent: number
  splay: number
  scale: number
  bufWidth: number
  bufHeight: number
  count: number
  indices: Uint32Array
  px: Uint16Array
  py: Uint16Array
  vecX: Float32Array
  vecY: Float32Array
  alpha: Uint8Array
  cpuReady: boolean
}

export interface AcquiredBevel {
  field: BevelField
  dataUrl: string
}

export interface EngineStats {
  fields: number
  consumers: number
  bitmaps: number
  snapshots: number
}

interface ActiveBevelEntry {
  field: BevelField
  dataUrl: string
  refCount: number
}

interface BevelSample {
  dx: number
  dy: number
  outerAlpha: number
  innerAlpha: number
}

let sharedCanvas: HTMLCanvasElement | null = null
let sharedCtx: CanvasRenderingContext2D | null = null
let revisionCounter = 0

const bitmapCache = new Map<string, string>()
const activeBevels = new Map<string, ActiveBevelEntry>()
const statListeners = new Set<() => void>()

let cachedStats: EngineStats = { fields: 0, consumers: 0, bitmaps: 0, snapshots: 0 }
let snapshotUnsub: (() => void) | null = null

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v
}

function clamp01(v: number): number {
  return clamp(v, 0, 1)
}

function notifyStats(): void {
  let consumers = 0
  for (const entry of activeBevels.values()) {
    consumers += entry.refCount
  }
  cachedStats = {
    fields: activeBevels.size,
    consumers,
    bitmaps: bitmapCache.size,
    snapshots: getSnapshotCount(),
  }
  for (const listener of statListeners) {
    listener()
  }
}

export function getEngineStats(): EngineStats {
  const snapCount = getSnapshotCount()
  if (cachedStats.snapshots !== snapCount) {
    cachedStats = { ...cachedStats, snapshots: snapCount }
  }
  return cachedStats
}

export function subscribeEngineStats(listener: () => void): () => void {
  if (!snapshotUnsub) {
    snapshotUnsub = subscribeSnapshotStats(notifyStats)
  }
  statListeners.add(listener)
  return () => {
    statListeners.delete(listener)
    if (statListeners.size === 0 && snapshotUnsub) {
      snapshotUnsub()
      snapshotUnsub = null
    }
  }
}

function getCanvasContext(width: number, height: number): {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
} | null {
  if (typeof document === 'undefined') return null
  if (!sharedCanvas) {
    sharedCanvas = document.createElement('canvas')
    sharedCtx = sharedCanvas.getContext('2d', { willReadFrequently: true })
  }
  if (!sharedCtx) return null
  if (sharedCanvas.width !== width) sharedCanvas.width = width
  if (sharedCanvas.height !== height) sharedCanvas.height = height
  return { canvas: sharedCanvas, ctx: sharedCtx }
}

function normalizeMapSpec(spec: DisplacementMapSpec): {
  w: number
  h: number
  r: number
  depth: number
  splay: number
  key: string
} {
  const w = Math.max(2, Math.round(spec.width))
  const h = Math.max(2, Math.round(spec.height))
  const maxR = Math.min(w, h) * 0.5
  const r = Math.round(clamp(spec.borderRadius, 0, maxR) * 2) / 2
  const depth = clamp(spec.depth, 0, 100)
  const splay = clamp(spec.splay, 0, 100)
  const key = `${w}x${h}_r${r.toFixed(1)}_d${depth.toFixed(1)}_s${splay.toFixed(1)}`
  return { w, h, r, depth, splay, key }
}

export function buildBevelHash(spec: BevelSpec): string {
  const norm = normalizeMapSpec(spec)
  const scale = clamp(spec.scale, 1, 2)
  return `${norm.key}_sc${scale.toFixed(2)}`
}

export function chooseRenderScale(width: number, height: number, depth: number): number {
  const maxDpr = typeof window !== 'undefined' ? clamp(window.devicePixelRatio || 1, 1, 2) : 1
  if (isWebGLRefractionAvailable()) {
    return Math.round(maxDpr * 4) / 4
  }
  const effectiveDepth = clamp(depth, 0, Math.min(width, height) * 0.5)
  const approxBevelPx = Math.min(width * height, 2 * (width + height) * effectiveDepth)
  const bounded = Math.sqrt(MAX_BEVEL_BUDGET / Math.max(1, approxBevelPx))
  const raw = clamp(bounded, 1, maxDpr)
  return Math.round(raw * 4) / 4
}

interface BevelCurveParams {
  hw: number
  hh: number
  bx: number
  by: number
  r: number
  effectiveDepth: number
  splayExp: number
  cornerExponent: number
  maxRadialSlope: number
}

/**
 * Steep convex Snell's-law rim bevel profile:
 *   f(t, p) = t^p, where t = 1 - (d / bevelWidth) in [0, 1]
 *   and p = 1.5 + (splay / 100) * 3.0.
 *
 * Optical properties:
 * - Interior (`d >= bevelWidth`, t = 0): strictly neutral (0 displacement, R=128, G=128).
 * - Inner bevel boundary (`t = 0`): f(0) = 0 and f'(0) = 0 (C¹ smooth tangent into flat center).
 * - Across `0 < t < 1`: f'(t) and f''(t) increase monotonically toward the outer rim.
 * - Outer perimeter (`d = 0`, t = 1): f(1) = 1 with peak slope `p` right at the outer edge,
 *   producing true Apple Liquid Glass edge folding, stretching, and RGB dispersion.
 */
function evalBevelMagnitude(u: number, splayExp: number): number {
  const t = clamp01(u)
  if (t <= 0) return 0
  if (t >= 1) return 1
  return Math.pow(t, splayExp)
}

function makeBevelCurveParams(w: number, h: number, r: number, depth: number, splay: number): BevelCurveParams {
  const hw = w * 0.5
  const hh = h * 0.5
  const bx = Math.max(0, hw - r)
  const by = Math.max(0, hh - r)
  const effectiveDepth = Math.max(0, Math.min(depth, Math.min(hw, hh)))
  const splayExp = 1.5 + (clamp(splay, 0, 100) / 100) * 3.0
  // Pure circle/pill cap (min(bx,by)=0) stays 100% circular (exponent 2.0);
  // rounded rectangles with straight sides smoothly blend in the 2.8 squircle corner normal.
  const straightRatio = clamp01(Math.min(bx, by) / Math.max(1, r))
  const cornerExponent = 2 + (SQUIRCLE_EXPONENT - 2) * straightRatio
  const maxRadialSlope = splayExp

  return { hw, hh, bx, by, r, effectiveDepth, splayExp, cornerExponent, maxRadialSlope }
}

/**
 * Shared 1/4-quadrant SDF + Snell convex bevel kernel.
 * Evaluates a point `(cx >= 0, cy >= 0)` relative to center in top-left quadrant coordinates.
 *
 * - Center beyond `depth` returns `null` (strictly neutral 128/128 displacement).
 * - Radial distance `sd` follows the true border-radius contour so circles stay 100% circular
 *   and rounded rectangles keep a uniform bevel width flush with the CSS clip.
 * - On rounded rectangles with straight edges, corner normals use the superellipse (`n = 2.8`)
 *   gradient so the normal direction transitions with C¹/C² continuity across the corner joint.
 */
function evalTopLeftBevel(cx: number, cy: number, p: BevelCurveParams): BevelSample | null {
  if (p.effectiveDepth <= 0.5) return null

  const qx = cx - p.bx
  const qy = cy - p.by
  const ox = qx > 0 ? qx : 0
  const oy = qy > 0 ? qy : 0
  const outLen = Math.hypot(ox, oy)
  const sd = outLen + Math.min(Math.max(qx, qy), 0) - p.r

  if (sd > 0.75) return null
  const distInward = sd < 0 ? -sd : 0
  if (distInward >= p.effectiveDepth) return null

  const outerAlpha = sd <= 0 ? 1 : 1 - sd / 0.75
  const u = clamp01(1 - distInward / p.effectiveDepth)
  const innerAlpha = 1
  const mag = evalBevelMagnitude(u, p.splayExp) * outerAlpha

  let ux = 0
  let uy = 0
  if (ox > 0 && oy > 0) {
    const n = p.cornerExponent
    const gx = Math.pow(ox, n - 1)
    const gy = Math.pow(oy, n - 1)
    const gl = Math.hypot(gx, gy) || 1
    ux = gx / gl
    uy = gy / gl
  } else if (outLen > 1e-6) {
    ux = ox / outLen
    uy = oy / outLen
  } else if (qx > qy) {
    ux = 1
  } else if (qy > qx) {
    uy = 1
  } else {
    ux = Math.SQRT1_2
    uy = Math.SQRT1_2
  }

  return {
    dx: ux * mag,
    dy: uy * mag,
    outerAlpha,
    innerAlpha,
  }
}

/**
 * Computes an R/G displacement debug bitmap via 1/4-quadrant symmetric rounded-rectangle SDF
 * and mirrors pixels into all four quadrants (R = ΔX, G = ΔY, 128 = neutral).
 */
export function generateDisplacementMap(spec: DisplacementMapSpec): string {
  const { w, h, r, depth, splay, key } = normalizeMapSpec(spec)

  const cached = bitmapCache.get(key)
  if (cached) {
    bitmapCache.delete(key)
    bitmapCache.set(key, cached)
    return cached
  }

  const surface = getCanvasContext(w, h)
  if (!surface) return ''

  const { canvas, ctx } = surface
  const imageData = ctx.createImageData(w, h)
  const data = imageData.data
  const curve = makeBevelCurveParams(w, h, r, depth, splay)

  const qW = Math.ceil(w * 0.5)
  const qH = Math.ceil(h * 0.5)

  for (let y = 0; y < qH; y++) {
    const cy = curve.hh - (y + 0.5)
    const my = h - 1 - y
    const rowTop = y * w
    const rowBot = my * w

    for (let x = 0; x < qW; x++) {
      const cx = curve.hw - (x + 0.5)
      const mx = w - 1 - x

      const sample = evalTopLeftBevel(cx, cy, curve)
      const rVal = sample ? Math.round(128 + sample.dx * 127) : 128
      const gVal = sample ? Math.round(128 + sample.dy * 127) : 128
      const rMir = 256 - rVal
      const gMir = 256 - gVal

      const idxTL = (rowTop + x) * 4
      data[idxTL] = rVal
      data[idxTL + 1] = gVal
      data[idxTL + 2] = 128
      data[idxTL + 3] = 255

      const idxTR = (rowTop + mx) * 4
      data[idxTR] = rMir
      data[idxTR + 1] = gVal
      data[idxTR + 2] = 128
      data[idxTR + 3] = 255

      const idxBL = (rowBot + x) * 4
      data[idxBL] = rVal
      data[idxBL + 1] = gMir
      data[idxBL + 2] = 128
      data[idxBL + 3] = 255

      const idxBR = (rowBot + mx) * 4
      data[idxBR] = rMir
      data[idxBR + 1] = gMir
      data[idxBR + 2] = 128
      data[idxBR + 3] = 255
    }
  }

  ctx.putImageData(imageData, 0, 0)
  const dataUrl = canvas.toDataURL('image/png')

  if (bitmapCache.size >= MAX_BITMAP_CACHE) {
    const oldestKey = bitmapCache.keys().next().value
    if (oldestKey !== undefined) bitmapCache.delete(oldestKey)
  }
  bitmapCache.set(key, dataUrl)
  return dataUrl
}

const EMPTY_U32 = new Uint32Array(0)
const EMPTY_U16 = new Uint16Array(0)
const EMPTY_F32 = new Float32Array(0)
const EMPTY_U8 = new Uint8Array(0)

function populateCpuBevelArrays(field: BevelField): void {
  if (field.cpuReady) return
  const { width: w, height: h, borderRadius: r, effectiveDepth, splay, scale, bufWidth, bufHeight } = field
  const curve = makeBevelCurveParams(w, h, r, effectiveDepth, splay)
  const qW = Math.ceil(bufWidth * 0.5)
  const qH = Math.ceil(bufHeight * 0.5)
  const invScale = 1 / scale

  const maxEntries = bufWidth * bufHeight
  const indices = new Uint32Array(maxEntries)
  const px = new Uint16Array(maxEntries)
  const py = new Uint16Array(maxEntries)
  const vecX = new Float32Array(maxEntries)
  const vecY = new Float32Array(maxEntries)
  const alpha = new Uint8Array(maxEntries)

  let count = 0
  const push = (col: number, row: number, vx: number, vy: number, a: number) => {
    indices[count] = row * bufWidth + col
    px[count] = col
    py[count] = row
    vecX[count] = vx
    vecY[count] = vy
    alpha[count] = a
    count++
  }

  for (let y = 0; y < qH; y++) {
    const cy = curve.hh - (y + 0.5) * invScale
    const my = bufHeight - 1 - y

    for (let x = 0; x < qW; x++) {
      const cx = curve.hw - (x + 0.5) * invScale
      const mx = bufWidth - 1 - x

      const sample = evalTopLeftBevel(cx, cy, curve)
      if (!sample) continue

      const aByte = Math.round(sample.outerAlpha * sample.innerAlpha * 255)
      if (aByte === 0) continue

      const { dx, dy } = sample
      push(x, y, dx, dy, aByte)
      if (mx !== x) push(mx, y, -dx, dy, aByte)
      if (my !== y) push(x, my, dx, -dy, aByte)
      if (mx !== x && my !== y) push(mx, my, -dx, -dy, aByte)
    }
  }

  field.count = count
  field.indices = indices.subarray(0, count)
  field.px = px.subarray(0, count)
  field.py = py.subarray(0, count)
  field.vecX = vecX.subarray(0, count)
  field.vecY = vecY.subarray(0, count)
  field.alpha = alpha.subarray(0, count)
  field.cpuReady = true
}

function buildBevelField(fieldId: string, hash: string, spec: BevelSpec): BevelField {
  const { w, h, r, depth, splay } = normalizeMapSpec(spec)
  const scale = clamp(spec.scale, 1, 2)
  const bufWidth = Math.max(2, Math.round(w * scale))
  const bufHeight = Math.max(2, Math.round(h * scale))
  const curve = makeBevelCurveParams(w, h, r, depth, splay)

  const field: BevelField = {
    fieldId,
    hash,
    width: w,
    height: h,
    borderRadius: r,
    effectiveDepth: curve.effectiveDepth,
    maxRadialSlope: curve.maxRadialSlope,
    splayExp: curve.splayExp,
    cornerExponent: curve.cornerExponent,
    splay,
    scale,
    bufWidth,
    bufHeight,
    count: 0,
    indices: EMPTY_U32,
    px: EMPTY_U16,
    py: EMPTY_U16,
    vecX: EMPTY_F32,
    vecY: EMPTY_F32,
    alpha: EMPTY_U8,
    cpuReady: false,
  }

  if (!isWebGLRefractionAvailable()) {
    populateCpuBevelArrays(field)
  }

  return field
}

export function acquireBevelField(spec: BevelSpec, needDataUrl = true): AcquiredBevel {
  const hash = buildBevelHash(spec)
  const existing = activeBevels.get(hash)
  if (existing) {
    existing.refCount += 1
    if (needDataUrl && !existing.dataUrl) {
      existing.dataUrl = generateDisplacementMap(spec)
    }
    notifyStats()
    return { field: existing.field, dataUrl: existing.dataUrl }
  }

  revisionCounter += 1
  const fieldId = `lg-b${revisionCounter}`
  const dataUrl = needDataUrl ? generateDisplacementMap(spec) : ''
  const field = buildBevelField(fieldId, hash, spec)

  activeBevels.set(hash, { field, dataUrl, refCount: 1 })
  notifyStats()
  return { field, dataUrl }
}

export function releaseBevelField(hash: string): void {
  const entry = activeBevels.get(hash)
  if (!entry) return
  entry.refCount -= 1
  if (entry.refCount <= 0) {
    activeBevels.delete(hash)
  }
  notifyStats()
}

function sampleChannel(
  srcData: Uint8ClampedArray,
  srcW: number,
  maxX: number,
  maxY: number,
  sx: number,
  sy: number,
  channel: number,
): number {
  const cx = sx < 0 ? 0 : sx > maxX ? maxX : sx
  const cy = sy < 0 ? 0 : sy > maxY ? maxY : sy
  const x0 = cx | 0
  const y0 = cy | 0
  const x1 = x0 < maxX ? x0 + 1 : x0
  const y1 = y0 < maxY ? y0 + 1 : y0
  const fx = cx - x0
  const fy = cy - y0
  const invFx = 1 - fx
  const invFy = 1 - fy

  const row0 = y0 * srcW
  const row1 = y1 * srcW
  const i00 = (row0 + x0) * 4 + channel
  const i10 = (row0 + x1) * 4 + channel
  const i01 = (row1 + x0) * 4 + channel
  const i11 = (row1 + x1) * 4 + channel

  const top = srcData[i00] * invFx + srcData[i10] * fx
  const bot = srcData[i01] * invFx + srcData[i11] * fx
  return top * invFy + bot * fy
}

/**
 * Renders only the displaced 1/4-mirrored bevel ring into `outImageData` by bilinearly
 * sampling `snapshot.data`. This is the refraction stage of the pipeline: it runs FIRST,
 * and the CSS `frost` backdrop blur is composited on top afterwards.
 *
 * - `refraction` (0–100): peak rim pull = `refraction / 100 × bevel depth × 1.5` px,
 *   peaking at the outer perimeter (`d = 0`) for true Apple Liquid Glass rim folding & pinching.
 * - `dispersion` (0–100): R/B channels sample along the bevel pull vector, so chromatic
 *   separation is zero in the flat center and peaks right along the curved outer rim.
 */
export function renderRefractedBevel(
  ctx: CanvasRenderingContext2D,
  outImageData: ImageData | null,
  field: BevelField,
  snapshot: TargetSnapshot,
  offsetX: number,
  offsetY: number,
  refraction: number,
  dispersion: number,
  tintColor = '',
): void {
  const dispCssPx = (clamp(refraction, 0, 100) / 100) * field.effectiveDepth * 1.5
  if (dispCssPx <= 0.001 || field.effectiveDepth <= 0.5) {
    ctx.clearRect(0, 0, field.bufWidth, field.bufHeight)
    return
  }

  const spread = (clamp(dispersion, 0, 100) / 100) * 0.36
  const parsedTint = tintColor ? parseCssColorRgba(tintColor) : null

  if (
    renderRefractedBevelWebGL(
      ctx,
      field,
      snapshot,
      offsetX,
      offsetY,
      dispCssPx,
      spread,
      parsedTint,
    )
  ) {
    if (tintColor && !parsedTint) {
      ctx.save()
      ctx.globalCompositeOperation = 'source-atop'
      ctx.fillStyle = tintColor
      ctx.fillRect(0, 0, field.bufWidth, field.bufHeight)
      ctx.restore()
    }
    return
  }

  populateCpuBevelArrays(field)
  if (field.count === 0) {
    ctx.clearRect(0, 0, field.bufWidth, field.bufHeight)
    return
  }

  const imgData = outImageData ?? ctx.createImageData(field.bufWidth, field.bufHeight)
  const outData = imgData.data
  const out32 = new Uint32Array(outData.buffer)
  out32.fill(0)

  const srcData = snapshot.data
  if (srcData.length === 0) {
    ctx.clearRect(0, 0, field.bufWidth, field.bufHeight)
    return
  }
  const srcW = snapshot.width
  const srcScale = snapshot.scale
  const maxX = srcW - 1
  const maxY = snapshot.height - 1
  const dispBufScale = dispCssPx * srcScale
  const ratio = srcScale / field.scale
  const baseOffsetSx = offsetX * srcScale - 0.5
  const baseOffsetSy = offsetY * srcScale - 0.5

  const { count, indices, px, py, vecX, vecY, alpha } = field
  const useChroma = spread > 0.0005

  if (!useChroma) {
    for (let i = 0; i < count; i++) {
      const sx = baseOffsetSx + (px[i] + 0.5) * ratio + vecX[i] * dispBufScale
      const sy = baseOffsetSy + (py[i] + 0.5) * ratio + vecY[i] * dispBufScale

      const cx = sx < 0 ? 0 : sx > maxX ? maxX : sx
      const cy = sy < 0 ? 0 : sy > maxY ? maxY : sy
      const x0 = cx | 0
      const y0 = cy | 0
      const x1 = x0 < maxX ? x0 + 1 : x0
      const y1 = y0 < maxY ? y0 + 1 : y0
      const fx = cx - x0
      const fy = cy - y0
      const invFx = 1 - fx
      const invFy = 1 - fy
      const w00 = invFx * invFy
      const w10 = fx * invFy
      const w01 = invFx * fy
      const w11 = fx * fy

      const row0 = y0 * srcW
      const row1 = y1 * srcW
      const i00 = (row0 + x0) * 4
      const i10 = (row0 + x1) * 4
      const i01 = (row1 + x0) * 4
      const i11 = (row1 + x1) * 4

      const dst = indices[i] * 4
      outData[dst] = srcData[i00] * w00 + srcData[i10] * w10 + srcData[i01] * w01 + srcData[i11] * w11
      outData[dst + 1] = srcData[i00 + 1] * w00 + srcData[i10 + 1] * w10 + srcData[i01 + 1] * w01 + srcData[i11 + 1] * w11
      outData[dst + 2] = srcData[i00 + 2] * w00 + srcData[i10 + 2] * w10 + srcData[i01 + 2] * w01 + srcData[i11 + 2] * w11
      const sA = srcData[i00 + 3] * w00 + srcData[i10 + 3] * w10 + srcData[i01 + 3] * w01 + srcData[i11 + 3] * w11
      outData[dst + 3] = (alpha[i] * sA) / 255
    }
  } else {
    const m0 = 1 - spread
    const m1 = 1 - spread * 0.5
    const m3 = 1 + spread * 0.5
    const m4 = 1 + spread

    for (let i = 0; i < count; i++) {
      const bx = baseOffsetSx + (px[i] + 0.5) * ratio
      const by = baseOffsetSy + (py[i] + 0.5) * ratio
      const dx = vecX[i] * dispBufScale
      const dy = vecY[i] * dispBufScale

      const x0 = bx + dx * m0
      const y0 = by + dy * m0
      const x1 = bx + dx * m1
      const y1 = by + dy * m1
      const x2 = bx + dx
      const y2 = by + dy
      const x3 = bx + dx * m3
      const y3 = by + dy * m3
      const x4 = bx + dx * m4
      const y4 = by + dy * m4

      const dst = indices[i] * 4
      outData[dst] =
        sampleChannel(srcData, srcW, maxX, maxY, x0, y0, 0) * 0.65 +
        sampleChannel(srcData, srcW, maxX, maxY, x1, y1, 0) * 0.35
      outData[dst + 1] =
        sampleChannel(srcData, srcW, maxX, maxY, x1, y1, 1) * 0.22 +
        sampleChannel(srcData, srcW, maxX, maxY, x2, y2, 1) * 0.56 +
        sampleChannel(srcData, srcW, maxX, maxY, x3, y3, 1) * 0.22
      outData[dst + 2] =
        sampleChannel(srcData, srcW, maxX, maxY, x3, y3, 2) * 0.35 +
        sampleChannel(srcData, srcW, maxX, maxY, x4, y4, 2) * 0.65
      const sA = sampleChannel(srcData, srcW, maxX, maxY, x2, y2, 3)
      outData[dst + 3] = (alpha[i] * sA) / 255
    }
  }

  const surface = getCanvasContext(field.bufWidth, field.bufHeight)
  if (surface) {
    surface.ctx.putImageData(imgData, 0, 0)
    ctx.clearRect(0, 0, field.bufWidth, field.bufHeight)
    const sx = offsetX * srcScale
    const sy = offsetY * srcScale
    const sw = field.width * srcScale
    const sh = field.height * srcScale
    if (sx >= 0 && sy >= 0 && sx + sw <= snapshot.width && sy + sh <= snapshot.height) {
      ctx.drawImage(snapshot.canvas, sx, sy, sw, sh, 0, 0, field.bufWidth, field.bufHeight)
    } else {
      const csx = clamp(sx, 0, snapshot.width)
      const csy = clamp(sy, 0, snapshot.height)
      const cex = clamp(sx + sw, 0, snapshot.width)
      const cey = clamp(sy + sh, 0, snapshot.height)
      const csw = cex - csx
      const csh = cey - csy
      if (csw > 0 && csh > 0) {
        const dx = ((csx - sx) / sw) * field.bufWidth
        const dy = ((csy - sy) / sh) * field.bufHeight
        const dw = (csw / sw) * field.bufWidth
        const dh = (csh / sh) * field.bufHeight
        ctx.drawImage(snapshot.canvas, csx, csy, csw, csh, dx, dy, dw, dh)
      }
    }
    ctx.drawImage(surface.canvas, 0, 0)
  } else {
    ctx.putImageData(imgData, 0, 0)
  }
  if (tintColor) {
    ctx.save()
    ctx.globalCompositeOperation = 'source-atop'
    ctx.fillStyle = tintColor
    ctx.fillRect(0, 0, field.bufWidth, field.bufHeight)
    ctx.restore()
  }
}
