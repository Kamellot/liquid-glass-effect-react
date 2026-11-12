import type { RefractionEngineMode, ResolvedRefractionPath } from './types'

const SVG_NS = 'http://www.w3.org/2000/svg'
const MAX_BITMAP_CACHE = 64

export interface DisplacementMapSpec {
  width: number
  height: number
  borderRadius: number
  depth: number
  curvature: number
  splay: number
}

export interface FilterSpec extends DisplacementMapSpec {
  strength: number
  chroma: number
}

export interface AcquiredFilter {
  filterId: string
  dataUrl: string
  hash: string
}

export interface FilterStats {
  filters: number
  consumers: number
  bitmaps: number
}

interface ActiveFilterEntry {
  filterId: string
  dataUrl: string
  node: SVGFilterElement
  refCount: number
}

let sharedCanvas: HTMLCanvasElement | null = null
let sharedCtx: CanvasRenderingContext2D | null = null
let sharedDefs: SVGDefsElement | null = null
let revisionCounter = 0

const bitmapCache = new Map<string, string>()
const activeFilters = new Map<string, ActiveFilterEntry>()
const statListeners = new Set<() => void>()

let cachedStats: FilterStats = { filters: 0, consumers: 0, bitmaps: 0 }

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v
}

function clamp01(v: number): number {
  return clamp(v, 0, 1)
}

function notifyStats(): void {
  let consumers = 0
  for (const entry of activeFilters.values()) {
    consumers += entry.refCount
  }
  cachedStats = {
    filters: activeFilters.size,
    consumers,
    bitmaps: bitmapCache.size,
  }
  for (const listener of statListeners) {
    listener()
  }
}

export function getFilterStats(): FilterStats {
  return cachedStats
}

export function subscribeFilterStats(listener: () => void): () => void {
  statListeners.add(listener)
  return () => {
    statListeners.delete(listener)
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

export function buildFilterHash(spec: FilterSpec): string {
  const mapNorm = normalizeMapSpec(spec)
  const strength = clamp(spec.strength, 0, 0.2)
  const chroma = clamp01(spec.chroma)
  return `${mapNorm.key}_st${strength.toFixed(4)}_ch${chroma.toFixed(3)}`
}

/**
 * Computes an R/G displacement bitmap via exact rounded-rectangle SDF + Snell's law bevel optics.
 * Uses 1/4 quadrant symmetry: evaluates ONLY the top-left quadrant and mirrors across X and Y axes.
 * Neutral (no shift) is encoded as R=128, G=128.
 */
export function generateDisplacementMap(spec: DisplacementMapSpec): string {
  const { w, h, r, depth, curvature, splay, key } = normalizeMapSpec(spec)

  const cached = bitmapCache.get(key)
  if (cached) {
    // Refresh LRU order
    bitmapCache.delete(key)
    bitmapCache.set(key, cached)
    return cached
  }

  const surface = getCanvasContext(w, h)
  if (!surface) return ''

  const { canvas, ctx } = surface
  const imageData = ctx.createImageData(w, h)
  const data = imageData.data

  const hw = w * 0.5
  const hh = h * 0.5
  const bx = Math.max(0, hw - r)
  const by = Math.max(0, hh - r)
  const effectiveDepth = Math.max(1, Math.min(depth, Math.min(hw, hh)))

  // Precompute bevel curve parameters outside the pixel loop
  const splayExp = 3.2 - 2.35 * splay
  const sinMax = 0.35 + 0.64 * curvature
  const maxDelta = Math.asin(sinMax) - Math.asin(sinMax / 1.52)
  const tanMaxDelta = Math.tan(maxDelta)
  const curvGain = curvature > 0 ? Math.pow(curvature, 0.65) : 0

  const qW = Math.ceil(w * 0.5)
  const qH = Math.ceil(h * 0.5)

  for (let y = 0; y < qH; y++) {
    const py = y + 0.5
    const cy = hh - py
    const my = h - 1 - y
    const rowTop = y * w
    const rowBot = my * w

    for (let x = 0; x < qW; x++) {
      const px = x + 0.5
      const cx = hw - px
      const mx = w - 1 - x

      // Exact Inigo Quilez rounded-box SDF in top-left quadrant (cx >= 0, cy >= 0)
      const qx = cx - bx
      const qy = cy - by
      const ox = qx > 0 ? qx : 0
      const oy = qy > 0 ? qy : 0
      const outLen = Math.hypot(ox, oy)
      const sd = outLen + Math.min(Math.max(qx, qy), 0) - r

      let rVal = 128
      let gVal = 128

      // Active bevel band: subpixel outer boundary (-0.75..0) through effectiveDepth inward
      if (sd <= 0.75 && curvGain > 0) {
        const distInward = sd < 0 ? -sd : 0
        if (distInward < effectiveDepth) {
          // Smooth anti-aliased falloff across subpixel border [0..0.75] outside edge
          const edgeAlpha = sd <= 0 ? 1 : 1 - sd / 0.75
          const u = 1 - distInward / effectiveDepth
          const uSplayed = Math.pow(u, splayExp)

          const sinI = uSplayed * sinMax
          const delta = Math.asin(sinI) - Math.asin(sinI / 1.52)
          const mag = (Math.tan(delta) / tanMaxDelta) * curvGain * edgeAlpha

          // Outward unit normal in screen coordinates (top-left quadrant has nx <= 0, ny <= 0)
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

          // Convex glass bends rays inward toward the thicker center (dx = -nx * mag >= 0)
          const dx = -nx * mag
          const dy = -ny * mag

          rVal = Math.round(128 + dx * 127)
          gVal = Math.round(128 + dy * 127)
        }
      }

      // Mirror across X and Y axes into all 4 quadrants; neutral = 128 -> 256 - 128 = 128
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

function ensureSharedDefs(): SVGDefsElement | null {
  if (typeof document === 'undefined') return null
  if (sharedDefs && sharedDefs.isConnected) return sharedDefs

  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('data-lg-svg-defs', 'true')
  svg.style.position = 'fixed'
  svg.style.width = '0'
  svg.style.height = '0'
  svg.style.overflow = 'hidden'
  svg.style.pointerEvents = 'none'

  const defs = document.createElementNS(SVG_NS, 'defs')
  svg.appendChild(defs)
  document.body.appendChild(svg)
  sharedDefs = defs
  return defs
}

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) {
    node.setAttribute(k, String(v))
  }
  return node
}

function createSvgFilterElement(
  filterId: string,
  dataUrl: string,
  width: number,
  height: number,
  strength: number,
  chroma: number,
): SVGFilterElement {
  const filter = svgEl('filter', {
    id: filterId,
    x: 0,
    y: 0,
    width,
    height,
    filterUnits: 'userSpaceOnUse',
    primitiveUnits: 'userSpaceOnUse',
    'color-interpolation-filters': 'sRGB',
  })

  filter.appendChild(
    svgEl('feImage', {
      href: dataUrl,
      x: 0,
      y: 0,
      width,
      height,
      preserveAspectRatio: 'none',
      result: 'lgMap',
    }),
  )

  const baseScale = strength * Math.min(width, height) * 2

  if (chroma <= 0.001) {
    filter.appendChild(
      svgEl('feDisplacementMap', {
        in: 'SourceGraphic',
        in2: 'lgMap',
        scale: baseScale.toFixed(3),
        xChannelSelector: 'R',
        yChannelSelector: 'G',
      }),
    )
    return filter
  }

  // Chromatic dispersion: R, G, B split with strength * (1 ± chroma * 0.18)
  const spread = chroma * 0.18
  const scaleR = baseScale * (1 - spread)
  const scaleG = baseScale
  const scaleB = baseScale * (1 + spread)

  filter.appendChild(
    svgEl('feDisplacementMap', {
      in: 'SourceGraphic',
      in2: 'lgMap',
      scale: scaleR.toFixed(3),
      xChannelSelector: 'R',
      yChannelSelector: 'G',
      result: 'dispR',
    }),
  )
  filter.appendChild(
    svgEl('feColorMatrix', {
      in: 'dispR',
      type: 'matrix',
      values: '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0',
      result: 'chanR',
    }),
  )

  filter.appendChild(
    svgEl('feDisplacementMap', {
      in: 'SourceGraphic',
      in2: 'lgMap',
      scale: scaleG.toFixed(3),
      xChannelSelector: 'R',
      yChannelSelector: 'G',
      result: 'dispG',
    }),
  )
  filter.appendChild(
    svgEl('feColorMatrix', {
      in: 'dispG',
      type: 'matrix',
      values: '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0',
      result: 'chanG',
    }),
  )

  filter.appendChild(
    svgEl('feDisplacementMap', {
      in: 'SourceGraphic',
      in2: 'lgMap',
      scale: scaleB.toFixed(3),
      xChannelSelector: 'R',
      yChannelSelector: 'G',
      result: 'dispB',
    }),
  )
  filter.appendChild(
    svgEl('feColorMatrix', {
      in: 'dispB',
      type: 'matrix',
      values: '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0',
      result: 'chanB',
    }),
  )

  filter.appendChild(
    svgEl('feBlend', {
      in: 'chanR',
      in2: 'chanG',
      mode: 'screen',
      result: 'chanRG',
    }),
  )
  filter.appendChild(
    svgEl('feBlend', {
      in: 'chanRG',
      in2: 'chanB',
      mode: 'screen',
    }),
  )

  return filter
}

/**
 * Acquires a shared, deduplicated SVG `<filter>` for the given geometry & optical spec.
 * Always assigns a monotonically increasing revision ID whenever a new filter node is created
 * so Safari/WebKit never displays stale cached SVG filter results.
 */
export function acquireFilter(spec: FilterSpec): AcquiredFilter | null {
  const defs = ensureSharedDefs()
  if (!defs) return null

  const norm = normalizeMapSpec(spec)
  const strength = clamp(spec.strength, 0, 0.2)
  const chroma = clamp01(spec.chroma)
  const hash = buildFilterHash(spec)

  const existing = activeFilters.get(hash)
  if (existing && existing.node.isConnected) {
    existing.refCount += 1
    notifyStats()
    return {
      filterId: existing.filterId,
      dataUrl: existing.dataUrl,
      hash,
    }
  }

  const dataUrl = generateDisplacementMap(spec)
  if (!dataUrl) return null

  revisionCounter += 1
  const filterId = `lg-f${revisionCounter}`
  const node = createSvgFilterElement(filterId, dataUrl, norm.w, norm.h, strength, chroma)
  defs.appendChild(node)

  activeFilters.set(hash, {
    filterId,
    dataUrl,
    node,
    refCount: 1,
  })
  notifyStats()

  return { filterId, dataUrl, hash }
}

export function releaseFilter(hash: string): void {
  const entry = activeFilters.get(hash)
  if (!entry) return
  entry.refCount -= 1
  if (entry.refCount <= 0) {
    entry.node.remove()
    activeFilters.delete(hash)
  }
  notifyStats()
}

let cachedBackdropSupport: boolean | null = null

/**
 * Chromium (Blink) supports `backdrop-filter: url(#svg-filter)`.
 * Safari (macOS/iOS WebKit) and Firefox (Gecko) ignore SVG URLs in `backdrop-filter`,
 * though they fully support `filter: url(#svg-filter)` on target elements.
 */
export function supportsBackdropSvgFilter(): boolean {
  if (cachedBackdropSupport !== null) return cachedBackdropSupport
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false

  const ua = navigator.userAgent
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const isFirefox = /Firefox|FxiOS/.test(ua)
  const isSafari = /Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR|CriOS|FxiOS/.test(ua)

  const hasCssBackdrop =
    typeof CSS !== 'undefined' &&
    typeof CSS.supports === 'function' &&
    (CSS.supports('backdrop-filter', 'url(#lg-probe)') || CSS.supports('-webkit-backdrop-filter', 'url(#lg-probe)'))

  cachedBackdropSupport = !isIOS && !isFirefox && !isSafari && hasCssBackdrop
  return cachedBackdropSupport
}

export function resolveRefractionPath(
  engine: RefractionEngineMode = 'auto',
  hasRefractionTarget = false,
): ResolvedRefractionPath {
  if (engine === 'css') return 'css-optics'
  if (engine === 'target') return hasRefractionTarget ? 'target-svg' : 'css-optics'
  if (engine === 'backdrop') return supportsBackdropSvgFilter() ? 'backdrop-svg' : hasRefractionTarget ? 'target-svg' : 'css-optics'

  if (supportsBackdropSvgFilter()) return 'backdrop-svg'
  if (hasRefractionTarget) return 'target-svg'
  return 'css-optics'
}

