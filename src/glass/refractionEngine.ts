import type { TargetSnapshot } from './domSnapshot'
import { getSnapshotCount, subscribeSnapshotStats } from './domSnapshot'

const MAX_BITMAP_CACHE = 64
const MAX_BEVEL_BUDGET = 72_000

export interface DisplacementMapSpec {
  width: number
  height: number
  borderRadius: number
  depth: number
  curvature: number
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
  softness: Uint8Array
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
  softness: number
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
  curvature: number
  splay: number
  key: string
} {
  const w = Math.max(2, Math.round(spec.width))
  const h = Math.max(2, Math.round(spec.height))
  const maxR = Math.min(w, h) * 0.5
  const r = Math.round(clamp(spec.borderRadius, 0, maxR) * 2) / 2
  const depth = clamp(spec.depth, 1, 50)
  const curvature = clamp01(spec.curvature)
  const splay = clamp01(spec.splay)
  const key = `${w}x${h}_r${r.toFixed(1)}_d${depth.toFixed(1)}_c${curvature.toFixed(3)}_s${splay.toFixed(3)}`
  return { w, h, r, depth, curvature, splay, key }
}

export function buildBevelHash(spec: BevelSpec): string {
  const norm = normalizeMapSpec(spec)
  const scale = clamp(spec.scale, 1, 2)
  return `${norm.key}_sc${scale.toFixed(2)}`
}

export function chooseRenderScale(width: number, height: number, depth: number): number {
  const maxDpr = typeof window !== 'undefined' ? clamp(window.devicePixelRatio || 1, 1, 2) : 1
  const effectiveDepth = clamp(depth, 1, Math.min(width, height) * 0.5)
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
  sinMax: number
  tanMaxDelta: number
  curvGain: number
}

function makeBevelCurveParams(
  w: number,
  h: number,
  r: number,
  depth: number,
  curvature: number,
  splay: number,
): BevelCurveParams {
  const hw = w * 0.5
  const hh = h * 0.5
  const bx = Math.max(0, hw - r)
  const by = Math.max(0, hh - r)
  const effectiveDepth = Math.max(1, Math.min(depth, Math.min(hw, hh)))
  // Cushioned C² sine-dome power controls bevel concentration without mid-ring S-inflection elbows
  const splayExp = 3.8 - 1.4 * splay
  // Keep peak incident sine bounded below total internal grazing so Snell refraction stays fluid without rim spikes
  const sinMax = 0.25 + 0.58 * curvature
  const maxDelta = Math.asin(sinMax) - Math.asin(sinMax / 1.52)
  const tanMaxDelta = Math.tan(maxDelta)
  const curvGain = curvature > 0 ? Math.pow(curvature, 0.7) : 0
  return { hw, hh, bx, by, r, effectiveDepth, splayExp, sinMax, tanMaxDelta, curvGain }
}

/**
 * Shared 1/4-quadrant SDF + Snell's law bevel kernel.
 * Evaluates a point `(cx >= 0, cy >= 0)` relative to center in top-left quadrant coordinates.
 */
function evalTopLeftBevel(cx: number, cy: number, p: BevelCurveParams): BevelSample | null {
  if (p.curvGain <= 0) return null

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
  // C² sine-dome guarantees zero slope & zero curvature at u = 0 and smoothly cushions rim Snell growth
  const uSplayed = Math.pow(Math.sin(u * Math.PI * 0.5), p.splayExp)
  // Gentle feather across the inner entry zone where displacement < 2% avoids razor seams against sharp text
  const tAlpha = clamp01(u / 0.16)
  const innerAlpha = tAlpha * tAlpha * (3 - 2 * tAlpha)
  // Optical softness eases in smoothly from 0 at u = 0 so high-contrast letter edges transition gently
  const tSoft = clamp01(u / 0.35)
  const softness = tSoft * tSoft * (3 - 2 * tSoft)

  const sinI = uSplayed * p.sinMax
  const delta = Math.asin(sinI) - Math.asin(sinI / 1.52)
  const mag = (Math.tan(delta) / p.tanMaxDelta) * p.curvGain * outerAlpha

  let nx = 0
  let ny = 0
  if (outLen > 1e-6) {
    nx = -ox / outLen
    ny = -oy / outLen
  } else if (qx > qy) {
    nx = -1
  } else if (qy > qx) {
    ny = -1
  } else {
    nx = -Math.SQRT1_2
    ny = -Math.SQRT1_2
  }

  return {
    dx: -nx * mag,
    dy: -ny * mag,
    outerAlpha,
    innerAlpha,
    softness,
  }
}

/**
 * Computes an R/G displacement debug bitmap via 1/4-quadrant symmetric rounded-rectangle SDF
 * and mirrors pixels into all four quadrants (R = ΔX, G = ΔY, 128 = neutral).
 */
export function generateDisplacementMap(spec: DisplacementMapSpec): string {
  const { w, h, r, depth, curvature, splay, key } = normalizeMapSpec(spec)

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
  const curve = makeBevelCurveParams(w, h, r, depth, curvature, splay)

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

function buildBevelField(fieldId: string, hash: string, spec: BevelSpec): BevelField {
  const { w, h, r, depth, curvature, splay } = normalizeMapSpec(spec)
  const scale = clamp(spec.scale, 1, 2)
  const bufWidth = Math.max(2, Math.round(w * scale))
  const bufHeight = Math.max(2, Math.round(h * scale))
  const curve = makeBevelCurveParams(w, h, r, depth, curvature, splay)

  const qW = Math.ceil(bufWidth * 0.5)
  const qH = Math.ceil(bufHeight * 0.5)
  const invScale = 1 / scale

  // Upper bound capacity: worst case bevel covers all buffer pixels
  const maxEntries = bufWidth * bufHeight
  const indices = new Uint32Array(maxEntries)
  const px = new Uint16Array(maxEntries)
  const py = new Uint16Array(maxEntries)
  const vecX = new Float32Array(maxEntries)
  const vecY = new Float32Array(maxEntries)
  const alpha = new Uint8Array(maxEntries)
  const softness = new Uint8Array(maxEntries)

  let count = 0
  const push = (col: number, row: number, vx: number, vy: number, a: number, s: number) => {
    indices[count] = row * bufWidth + col
    px[count] = col
    py[count] = row
    vecX[count] = vx
    vecY[count] = vy
    alpha[count] = a
    softness[count] = s
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

      const sByte = Math.round(sample.softness * 255)
      const { dx, dy } = sample
      push(x, y, dx, dy, aByte, sByte)
      if (mx !== x) push(mx, y, -dx, dy, aByte, sByte)
      if (my !== y) push(x, my, dx, -dy, aByte, sByte)
      if (mx !== x && my !== y) push(mx, my, -dx, -dy, aByte, sByte)
    }
  }

  return {
    fieldId,
    hash,
    width: w,
    height: h,
    borderRadius: r,
    effectiveDepth: curve.effectiveDepth,
    scale,
    bufWidth,
    bufHeight,
    count,
    indices: indices.subarray(0, count),
    px: px.subarray(0, count),
    py: py.subarray(0, count),
    vecX: vecX.subarray(0, count),
    vecY: vecY.subarray(0, count),
    alpha: alpha.subarray(0, count),
    softness: softness.subarray(0, count),
  }
}

export function acquireBevelField(spec: BevelSpec): AcquiredBevel {
  const hash = buildBevelHash(spec)
  const existing = activeBevels.get(hash)
  if (existing) {
    existing.refCount += 1
    notifyStats()
    return { field: existing.field, dataUrl: existing.dataUrl }
  }

  revisionCounter += 1
  const fieldId = `lg-b${revisionCounter}`
  const dataUrl = generateDisplacementMap(spec)
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
 * sampling `snapshot.data` with optional chromatic R/G/B dispersion.
 */
export function renderRefractedBevel(
  ctx: CanvasRenderingContext2D,
  outImageData: ImageData,
  field: BevelField,
  snapshot: TargetSnapshot,
  offsetX: number,
  offsetY: number,
  strength: number,
  chroma: number,
): void {
  const outData = outImageData.data
  const out32 = new Uint32Array(outData.buffer)
  out32.fill(0)

  const rawDisp = clamp(strength, 0, 0.2) * Math.min(field.width, field.height) * 0.75
  // Asymptotic soft knee prevents radial stalling / caustic folds at high strength relative to bevel depth
  const maxSafe = field.effectiveDepth * 0.45 + 2
  const dispCssPx = rawDisp <= maxSafe ? rawDisp : maxSafe + (rawDisp - maxSafe) * 0.08
  if (dispCssPx <= 0.001 || field.count === 0) {
    ctx.putImageData(outImageData, 0, 0)
    return
  }

  const srcData = snapshot.data
  const srcW = snapshot.width
  const srcScale = snapshot.scale
  const maxX = srcW - 1
  const maxY = snapshot.height - 1
  const dispBufScale = dispCssPx * srcScale
  const ratio = srcScale / field.scale
  const baseOffsetSx = offsetX * srcScale - 0.5
  const baseOffsetSy = offsetY * srcScale - 0.5

  const peakSoftCss =
    Math.min(1, dispCssPx / 3.0) * Math.min(1.05, 0.35 + 0.55 * (dispCssPx / Math.max(4, field.effectiveDepth)))
  const softStepBuf = (peakSoftCss * srcScale) / 255
  const softMinBuf = 0.08 * srcScale

  const { count, indices, px, py, vecX, vecY, alpha, softness } = field
  const spread = clamp01(chroma) * 0.18
  const useChroma = spread > 0.0005

  const accum = new Float64Array(4)
  const accumBilinearRgba = (sx: number, sy: number) => {
    const cx = sx < 0 ? 0 : sx > maxX ? maxX : sx
    const cy = sy < 0 ? 0 : sy > maxY ? maxY : sy
    const x0 = cx | 0
    const y0 = cy | 0
    const x1 = x0 < maxX ? x0 + 1 : x0
    const y1 = y0 < maxY ? y0 + 1 : y0
    const fx = cx - x0
    const fy = cy - y0
    const w00 = (1 - fx) * (1 - fy)
    const w10 = fx * (1 - fy)
    const w01 = (1 - fx) * fy
    const w11 = fx * fy
    const row0 = y0 * srcW
    const row1 = y1 * srcW
    const i00 = (row0 + x0) * 4
    const i10 = (row0 + x1) * 4
    const i01 = (row1 + x0) * 4
    const i11 = (row1 + x1) * 4
    accum[0] += srcData[i00] * w00 + srcData[i10] * w10 + srcData[i01] * w01 + srcData[i11] * w11
    accum[1] += srcData[i00 + 1] * w00 + srcData[i10 + 1] * w10 + srcData[i01 + 1] * w01 + srcData[i11 + 1] * w11
    accum[2] += srcData[i00 + 2] * w00 + srcData[i10 + 2] * w10 + srcData[i01 + 2] * w01 + srcData[i11 + 2] * w11
    accum[3] += srcData[i00 + 3] * w00 + srcData[i10 + 3] * w10 + srcData[i01 + 3] * w01 + srcData[i11 + 3] * w11
  }

  if (!useChroma) {
    for (let i = 0; i < count; i++) {
      const sx = baseOffsetSx + (px[i] + 0.5) * ratio + vecX[i] * dispBufScale
      const sy = baseOffsetSy + (py[i] + 0.5) * ratio + vecY[i] * dispBufScale
      const dst = indices[i] * 4
      const aByte = alpha[i]
      const blurBuf = softness[i] * softStepBuf

      accum[0] = 0
      accum[1] = 0
      accum[2] = 0
      accum[3] = 0

      if (blurBuf <= softMinBuf) {
        accumBilinearRgba(sx, sy)
        outData[dst] = accum[0]
        outData[dst + 1] = accum[1]
        outData[dst + 2] = accum[2]
        outData[dst + 3] = (aByte * accum[3]) / 255
      } else {
        // Symmetric 4-tap rotated optical softness prevents jagged binary edges on crisp display text
        const d = blurBuf * 0.7071
        accumBilinearRgba(sx + d, sy + d)
        accumBilinearRgba(sx - d, sy - d)
        accumBilinearRgba(sx + d, sy - d)
        accumBilinearRgba(sx - d, sy + d)
        outData[dst] = accum[0] * 0.25
        outData[dst + 1] = accum[1] * 0.25
        outData[dst + 2] = accum[2] * 0.25
        outData[dst + 3] = (aByte * accum[3] * 0.25) / 255
      }
    }
  } else {
    const rMult = 1 - spread
    const bMult = 1 + spread

    for (let i = 0; i < count; i++) {
      const bx = baseOffsetSx + (px[i] + 0.5) * ratio
      const by = baseOffsetSy + (py[i] + 0.5) * ratio
      const dx = vecX[i] * dispBufScale
      const dy = vecY[i] * dispBufScale

      const sxG = bx + dx
      const syG = by + dy
      const sxR = bx + dx * rMult
      const syR = by + dy * rMult
      const sxB = bx + dx * bMult
      const syB = by + dy * bMult

      const dst = indices[i] * 4
      const blurBuf = softness[i] * softStepBuf
      if (blurBuf <= softMinBuf) {
        outData[dst] = sampleChannel(srcData, srcW, maxX, maxY, sxR, syR, 0)
        outData[dst + 1] = sampleChannel(srcData, srcW, maxX, maxY, sxG, syG, 1)
        outData[dst + 2] = sampleChannel(srcData, srcW, maxX, maxY, sxB, syB, 2)
        const sA = sampleChannel(srcData, srcW, maxX, maxY, sxG, syG, 3)
        outData[dst + 3] = (alpha[i] * sA) / 255
      } else {
        const dLen = Math.hypot(dx, dy)
        const perp = blurBuf * 0.7
        const tx = dLen > 1e-5 ? (-dy / dLen) * perp : perp
        const ty = dLen > 1e-5 ? (dx / dLen) * perp : 0
        outData[dst] = 0.5 * (sampleChannel(srcData, srcW, maxX, maxY, sxR + tx, syR + ty, 0) + sampleChannel(srcData, srcW, maxX, maxY, sxR - tx, syR - ty, 0))
        outData[dst + 1] = 0.5 * (sampleChannel(srcData, srcW, maxX, maxY, sxG + tx, syG + ty, 1) + sampleChannel(srcData, srcW, maxX, maxY, sxG - tx, syG - ty, 1))
        outData[dst + 2] = 0.5 * (sampleChannel(srcData, srcW, maxX, maxY, sxB + tx, syB + ty, 2) + sampleChannel(srcData, srcW, maxX, maxY, sxB - tx, syB - ty, 2))
        const sA = 0.5 * (sampleChannel(srcData, srcW, maxX, maxY, sxG + tx, syG + ty, 3) + sampleChannel(srcData, srcW, maxX, maxY, sxG - tx, syG - ty, 3))
        outData[dst + 3] = (alpha[i] * sA) / 255
      }
    }
  }

  ctx.putImageData(outImageData, 0, 0)
}
