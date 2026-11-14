import {
  BEVEL_MIN_DEPTH,
  BEVEL_OUTER_AA_PX,
  BEVEL_REFRACTION_FACTOR,
  DISPERSION_MAX_SPREAD,
  FROST_MIN_THRESHOLD,
  MAX_BEVEL_BUDGET,
  MAX_BITMAP_CACHE,
  MAX_RENDER_DPR,
  MAX_WEBGL_PIXEL_BUDGET,
  MIN_WEBGL_SCALE,
  NEUTRAL_DISPLACEMENT_CHANNEL,
  SQUIRCLE_EXPONENT,
} from './constants'
import type { TargetSnapshot } from './domSnapshot'
import { getSnapshotCount, subscribeSnapshotStats } from './domSnapshot'
import { clamp, clamp01, parseCssColorRgba } from './utils'
import { isWebGLRefractionAvailable, renderRefractedBevelWebGL } from './webglRefraction'

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
  hw: number
  hh: number
  bx: number
  by: number
  borderRadius: number
  effectiveDepth: number
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
}

let sharedCanvas: HTMLCanvasElement | null = null
let sharedCtx: CanvasRenderingContext2D | null = null
let revisionCounter = 0

const bitmapCache = new Map<string, string>()
const activeBevels = new Map<string, ActiveBevelEntry>()
const statListeners = new Set<() => void>()

let cachedStats: EngineStats = { fields: 0, consumers: 0, bitmaps: 0, snapshots: 0 }
let snapshotUnsub: (() => void) | null = null

const EMPTY_U32 = new Uint32Array(0)
const EMPTY_U16 = new Uint16Array(0)
const EMPTY_F32 = new Float32Array(0)
const EMPTY_U8 = new Uint8Array(0)

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

function releaseSharedCanvas(): void {
  if (sharedCanvas) {
    sharedCanvas.width = 0
    sharedCanvas.height = 0
    sharedCanvas = null
    sharedCtx = null
  }
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
  const r = Math.round(clamp(spec.borderRadius, 0, Math.min(w, h) * 0.5) * 2) / 2
  const depth = clamp(spec.depth, 0, 100)
  const splay = clamp(spec.splay, 0, 100)
  const key = `${w}x${h}_r${r.toFixed(1)}_d${depth.toFixed(1)}_s${splay.toFixed(1)}`
  return { w, h, r, depth, splay, key }
}

export function buildBevelHash(spec: BevelSpec): string {
  const norm = normalizeMapSpec(spec)
  const scale = clamp(spec.scale, 1, MAX_RENDER_DPR)
  return `${norm.key}_sc${scale.toFixed(2)}`
}

export function chooseRenderScale(width: number, height: number, depth: number): number {
  const maxDpr = typeof window !== 'undefined' ? clamp(window.devicePixelRatio || 1, 1, MAX_RENDER_DPR) : 1
  if (isWebGLRefractionAvailable()) {
    const area = Math.max(1, width * height)
    const pixelBudgetCap = Math.sqrt(MAX_WEBGL_PIXEL_BUDGET / area)
    return Math.round(clamp(pixelBudgetCap, MIN_WEBGL_SCALE, maxDpr) * 4) / 4
  }
  const effectiveDepth = clamp(depth, 0, Math.min(width, height) * 0.5)
  const approxBevelPx = Math.min(width * height, 2 * (width + height) * effectiveDepth)
  const bounded = Math.sqrt(MAX_BEVEL_BUDGET / Math.max(1, approxBevelPx))
  return Math.round(clamp(bounded, 1, maxDpr) * 4) / 4
}

/**
 * Convex bevel magnitude f(t, p) = t^p where t = 1 - d / bevelWidth in [0, 1] and p = 1.5 + (splay/100)*3.
 * Guarantees f(0) = f'(0) = 0 for a C¹ tangent transition into the neutral interior while peaking at the outer rim.
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
  // Blend circle (n = 2.0) toward squircle (n = 2.8) only when straight sides exist, keeping circles exact.
  const straightRatio = clamp01(Math.min(bx, by) / Math.max(1, r))
  const cornerExponent = 2 + (SQUIRCLE_EXPONENT - 2) * straightRatio

  return { hw, hh, bx, by, r, effectiveDepth, splayExp, cornerExponent }
}

/**
 * 1/4-quadrant symmetric rounded-rectangle SDF bevel kernel.
 * Evaluates `(cx >= 0, cy >= 0)` relative to center in top-left coordinates; returns `null` in the flat interior.
 * Corner normals use the superellipse gradient (`n = cornerExponent`) for C¹/C² continuity across corner joints.
 */
function evalTopLeftBevel(cx: number, cy: number, p: BevelCurveParams): BevelSample | null {
  if (p.effectiveDepth <= BEVEL_MIN_DEPTH) return null

  const qx = cx - p.bx
  const qy = cy - p.by
  const ox = qx > 0 ? qx : 0
  const oy = qy > 0 ? qy : 0
  const outLen = Math.hypot(ox, oy)
  const sd = outLen + Math.min(Math.max(qx, qy), 0) - p.r

  if (sd > BEVEL_OUTER_AA_PX) return null
  const distInward = sd < 0 ? -sd : 0
  if (distInward >= p.effectiveDepth) return null

  const outerAlpha = sd <= 0 ? 1 : 1 - sd / BEVEL_OUTER_AA_PX
  const u = clamp01(1 - distInward / p.effectiveDepth)
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

  return { dx: ux * mag, dy: uy * mag, outerAlpha }
}

/**
 * Generates an R/G displacement debug bitmap from the 1/4-quadrant SDF mirrored across all four quadrants.
 * Channel encoding uses 128 as neutral zero-displacement baseline (R = ΔX, G = ΔY; values >128 shift +X/+Y).
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
  const neutral = NEUTRAL_DISPLACEMENT_CHANNEL
  const mirrorMax = neutral * 2

  for (let y = 0; y < qH; y++) {
    const cy = curve.hh - (y + 0.5)
    const my = h - 1 - y
    const rowTop = y * w
    const rowBot = my * w

    for (let x = 0; x < qW; x++) {
      const cx = curve.hw - (x + 0.5)
      const mx = w - 1 - x
      const sample = evalTopLeftBevel(cx, cy, curve)
      const rVal = sample ? Math.round(neutral + sample.dx * (neutral - 1)) : neutral
      const gVal = sample ? Math.round(neutral + sample.dy * (neutral - 1)) : neutral
      const rMir = mirrorMax - rVal
      const gMir = mirrorMax - gVal

      const idxTL = (rowTop + x) * 4
      data[idxTL] = rVal
      data[idxTL + 1] = gVal
      data[idxTL + 2] = neutral
      data[idxTL + 3] = 255

      const idxTR = (rowTop + mx) * 4
      data[idxTR] = rMir
      data[idxTR + 1] = gVal
      data[idxTR + 2] = neutral
      data[idxTR + 3] = 255

      const idxBL = (rowBot + x) * 4
      data[idxBL] = rVal
      data[idxBL + 1] = gMir
      data[idxBL + 2] = neutral
      data[idxBL + 3] = 255

      const idxBR = (rowBot + mx) * 4
      data[idxBR] = rMir
      data[idxBR + 1] = gMir
      data[idxBR + 2] = neutral
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

      const aByte = Math.round(sample.outerAlpha * 255)
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
  const scale = clamp(spec.scale, 1, MAX_RENDER_DPR)
  const bufWidth = Math.max(2, Math.round(w * scale))
  const bufHeight = Math.max(2, Math.round(h * scale))
  const curve = makeBevelCurveParams(w, h, r, depth, splay)

  const field: BevelField = {
    fieldId,
    hash,
    width: w,
    height: h,
    hw: curve.hw,
    hh: curve.hh,
    bx: curve.bx,
    by: curve.by,
    borderRadius: r,
    effectiveDepth: curve.effectiveDepth,
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
    if (activeBevels.size === 0) {
      releaseSharedCanvas()
    }
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
  const cx = clamp(sx, 0, maxX)
  const cy = clamp(sy, 0, maxY)
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

function renderCpuMonochrome(
  outData: Uint8ClampedArray,
  field: BevelField,
  srcData: Uint8ClampedArray,
  srcW: number,
  maxX: number,
  maxY: number,
  dispBufScale: number,
  ratio: number,
  baseOffsetSx: number,
  baseOffsetSy: number,
): void {
  const { count, indices, px, py, vecX, vecY, alpha } = field

  for (let i = 0; i < count; i++) {
    const sx = baseOffsetSx + (px[i] + 0.5) * ratio + vecX[i] * dispBufScale
    const sy = baseOffsetSy + (py[i] + 0.5) * ratio + vecY[i] * dispBufScale

    const cx = clamp(sx, 0, maxX)
    const cy = clamp(sy, 0, maxY)
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
}

function renderCpuChromatic(
  outData: Uint8ClampedArray,
  field: BevelField,
  srcData: Uint8ClampedArray,
  srcW: number,
  maxX: number,
  maxY: number,
  dispBufScale: number,
  spread: number,
  ratio: number,
  baseOffsetSx: number,
  baseOffsetSy: number,
): void {
  const { count, indices, px, py, vecX, vecY, alpha } = field
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

function compositeCpuBevel(
  ctx: CanvasRenderingContext2D,
  imgData: ImageData,
  field: BevelField,
  snapshot: TargetSnapshot,
  offsetX: number,
  offsetY: number,
): void {
  const surface = getCanvasContext(field.bufWidth, field.bufHeight)
  if (!surface) {
    ctx.putImageData(imgData, 0, 0)
    return
  }

  surface.ctx.putImageData(imgData, 0, 0)
  ctx.clearRect(0, 0, field.bufWidth, field.bufHeight)

  const srcScale = snapshot.scale
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
}

function applyTintOverlay(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  tintColor: string,
): void {
  ctx.save()
  ctx.globalCompositeOperation = 'source-atop'
  ctx.fillStyle = tintColor
  ctx.fillRect(0, 0, width, height)
  ctx.restore()
}

/**
 * Renders the refracted and dispersed bevel ring onto `ctx` (WebGL first, bilinear CPU fallback).
 * Runs ahead of the CSS backdrop frost layer so edge refractions diffuse cleanly when frost is active.
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
  frost = 0,
): void {
  const dispCssPx = (clamp(refraction, 0, 100) / 100) * field.effectiveDepth * BEVEL_REFRACTION_FACTOR
  const hasRefract = dispCssPx > 0.001 && field.effectiveDepth > BEVEL_MIN_DEPTH
  const hasFrost = frost > FROST_MIN_THRESHOLD
  if (!hasRefract && !hasFrost) {
    ctx.clearRect(0, 0, field.bufWidth, field.bufHeight)
    return
  }

  const spread = (clamp(dispersion, 0, 100) / 100) * DISPERSION_MAX_SPREAD
  const parsedTint = tintColor ? parseCssColorRgba(tintColor) : null

  if (
    renderRefractedBevelWebGL(
      ctx,
      field,
      snapshot,
      offsetX,
      offsetY,
      hasRefract ? dispCssPx : 0,
      spread,
      parsedTint,
      frost,
    )
  ) {
    if (tintColor && !parsedTint) {
      applyTintOverlay(ctx, field.bufWidth, field.bufHeight, tintColor)
    }
    return
  }

  if (!hasRefract) {
    ctx.clearRect(0, 0, field.bufWidth, field.bufHeight)
    return
  }

  populateCpuBevelArrays(field)
  const srcData = snapshot.data
  if (field.count === 0 || srcData.length === 0) {
    ctx.clearRect(0, 0, field.bufWidth, field.bufHeight)
    return
  }

  const imgData = outImageData ?? ctx.createImageData(field.bufWidth, field.bufHeight)
  const outData = imgData.data
  new Uint32Array(outData.buffer).fill(0)

  const srcW = snapshot.width
  const srcScale = snapshot.scale
  const maxX = srcW - 1
  const maxY = snapshot.height - 1
  const dispBufScale = dispCssPx * srcScale
  const ratio = srcScale / field.scale
  const baseOffsetSx = offsetX * srcScale - 0.5
  const baseOffsetSy = offsetY * srcScale - 0.5

  if (spread <= 0.0005) {
    renderCpuMonochrome(outData, field, srcData, srcW, maxX, maxY, dispBufScale, ratio, baseOffsetSx, baseOffsetSy)
  } else {
    renderCpuChromatic(outData, field, srcData, srcW, maxX, maxY, dispBufScale, spread, ratio, baseOffsetSx, baseOffsetSy)
  }

  compositeCpuBevel(ctx, imgData, field, snapshot, offsetX, offsetY)
  if (tintColor) {
    applyTintOverlay(ctx, field.bufWidth, field.bufHeight, tintColor)
  }
}
