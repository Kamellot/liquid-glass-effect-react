import {
  MAX_ASSET_CACHE,
  MAX_SNAP_DIM,
  MAX_SORTED_CONSUMERS,
  MAX_VIDEO_SNAP_DIM,
  MIN_VIDEO_CAPTURE_INTERVAL_MS,
  OVERLAP_MARGIN_PX,
  SCOPE_RECT_CACHE_TTL_MS,
  SNAPSHOT_ROOT_MARGIN,
} from './constants'
import { clamp, degToRad, isTransparentColor, nowMs, parseCornerRadii, parseLengthPx } from './utils'
import { releaseWebGLSnapshot } from './webglRefraction'

export interface TargetSnapshot {
  readonly data: Uint8ClampedArray
  canvas: HTMLCanvasElement
  version: number
  width: number
  height: number
  scale: number
  cssWidth: number
  cssHeight: number
}

interface AssetEntry {
  status: 'loading' | 'ready' | 'error'
  img: HTMLImageElement
  waiters: Set<() => void>
}

interface ConsumerRecord {
  onUpdate: () => void
  rootEl: HTMLElement | null
  scopeEl: HTMLElement | null
  compCanvas: HTMLCanvasElement | null
  compCtx: CanvasRenderingContext2D | null
  compVersion: number
  compSnapshot: TargetSnapshot | null
  lastOverlappedScopes: Set<HTMLElement>
  cachedRect: DOMRect | null
  cachedRectAt: number
}

interface SnapshotEntry {
  target: HTMLElement
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  snapshot: TargetSnapshot | null
  version: number
  isVisible: boolean
  deferredWhileHidden: boolean
  hasActiveVideo: boolean
  lastVideoCaptureAt: number
  videoCallbacks: WeakSet<HTMLVideoElement>
  consumers: Map<() => void, ConsumerRecord>
  notifyingScopes: Set<HTMLElement>
  dirtyScopes: Set<HTMLElement>
  dirtyScopeRaf: number
  ro: ResizeObserver
  mo: MutationObserver
  io: IntersectionObserver | null
  onMedia: () => void
  onVisibilityChange: () => void
  rafId: number
}

const POSITION_KEYWORDS: Record<string, string> = {
  left: '0%',
  center: '50%',
  right: '100%',
  top: '0%',
  bottom: '100%',
}

const assetCache = new Map<string, AssetEntry>()
const snapshotRegistry = new Map<HTMLElement, SnapshotEntry>()
const statsListeners = new Set<() => void>()

export function getSnapshotCount(): number {
  return snapshotRegistry.size
}

export function subscribeSnapshotStats(listener: () => void): () => void {
  statsListeners.add(listener)
  return () => {
    statsListeners.delete(listener)
  }
}

function notifySnapshotStats(): void {
  for (const listener of statsListeners) listener()
}

function splitTopLevel(input: string, delimiter: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  let quote: string | null = null

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (quote) {
      if (ch === quote && input[i - 1] !== '\\') quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '(') {
      depth++
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1)
    } else if (depth === 0 && ch === delimiter) {
      out.push(input.slice(start, i).trim())
      start = i + 1
    }
  }
  const tail = input.slice(start).trim()
  if (tail) out.push(tail)
  return out
}

function tokenizeTopLevelSpaces(input: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = -1
  let quote: string | null = null

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (quote) {
      if (ch === quote && input[i - 1] !== '\\') quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      if (start === -1) start = i
      quote = ch
    } else if (ch === '(') {
      if (start === -1) start = i
      depth++
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1)
    } else if (depth === 0 && /\s/.test(ch)) {
      if (start !== -1) {
        out.push(input.slice(start, i))
        start = -1
      }
    } else if (start === -1) {
      start = i
    }
  }
  if (start !== -1) out.push(input.slice(start))
  return out
}

function evictOldestAssetIfFull(): void {
  if (assetCache.size < MAX_ASSET_CACHE) return
  const oldestKey = assetCache.keys().next().value
  if (oldestKey === undefined) return
  const evicted = assetCache.get(oldestKey)
  if (evicted) {
    evicted.img.onload = null
    evicted.img.onerror = null
    evicted.waiters.clear()
  }
  assetCache.delete(oldestKey)
}

function loadAsset(url: string, onReady: () => void): HTMLImageElement | null {
  const cached = assetCache.get(url)
  if (cached) {
    assetCache.delete(url)
    assetCache.set(url, cached)
    if (cached.status === 'ready') return cached.img
    if (cached.status === 'loading') cached.waiters.add(onReady)
    return null
  }

  const img = new Image()
  const isInline = url.startsWith('data:') || url.startsWith('blob:')
  if (!isInline && typeof window !== 'undefined') {
    try {
      const resolved = new URL(url, window.location.href)
      if (resolved.origin !== window.location.origin) {
        img.crossOrigin = 'anonymous'
      }
    } catch {
      // Malformed URL falls back to default same-origin fetch behavior.
    }
  }

  const entry: AssetEntry = { status: 'loading', img, waiters: new Set([onReady]) }
  evictOldestAssetIfFull()
  assetCache.set(url, entry)

  const finish = (ok: boolean) => {
    entry.status = ok && img.naturalWidth > 0 ? 'ready' : 'error'
    const listeners = Array.from(entry.waiters)
    entry.waiters.clear()
    if (entry.status === 'ready') {
      for (const fn of listeners) fn()
    }
  }

  img.onload = () => finish(true)
  img.onerror = () => finish(false)
  img.src = url

  if (img.complete && img.naturalWidth > 0) {
    entry.status = 'ready'
    entry.waiters.clear()
    return img
  }
  return null
}

function traceRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radii: [number, number, number, number],
): void {
  ctx.beginPath()
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, radii)
    return
  }
  const [rTL, rTR, rBR, rBL] = radii
  ctx.moveTo(x + rTL, y)
  ctx.lineTo(x + w - rTR, y)
  ctx.arcTo(x + w, y, x + w, y + rTR, rTR)
  ctx.lineTo(x + w, y + h - rBR)
  ctx.arcTo(x + w, y + h, x + w - rBR, y + h, rBR)
  ctx.lineTo(x + rBL, y + h)
  ctx.arcTo(x, y + h, x, y + h - rBL, rBL)
  ctx.lineTo(x, y + rTL)
  ctx.arcTo(x, y, x + rTL, y, rTL)
  ctx.closePath()
}

function withRoundedClip(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radii: [number, number, number, number],
  hasRadius: boolean,
  draw: () => void,
): void {
  ctx.save()
  if (hasRadius) {
    traceRoundedRect(ctx, x, y, w, h, radii)
    ctx.clip()
  }
  draw()
  ctx.restore()
}

interface ParsedStop {
  color: string
  offset: number | null
}

function parseStops(rawStops: string[], axisLen: number): { color: string; offset: number }[] {
  const list: ParsedStop[] = []
  for (const s of rawStops) {
    const tokens = tokenizeTopLevelSpaces(s)
    if (!tokens.length) continue
    const color = tokens[0]
    if (tokens.length === 1) {
      list.push({ color, offset: null })
      continue
    }
    for (let j = 1; j < tokens.length; j++) {
      const t = tokens[j]
      const val = parseFloat(t)
      if (!Number.isFinite(val)) continue
      const off = t.endsWith('%') ? val / 100 : axisLen > 0 ? val / axisLen : 0
      list.push({ color, offset: clamp(off, 0, 1) })
    }
  }
  if (!list.length) return []

  if (list[0].offset === null) list[0].offset = 0
  if (list[list.length - 1].offset === null) list[list.length - 1].offset = 1

  let prevVal = 0
  for (const stop of list) {
    if (stop.offset !== null) {
      stop.offset = Math.max(prevVal, stop.offset)
      prevVal = stop.offset
    }
  }

  let i = 0
  while (i < list.length) {
    if (list[i].offset === null) {
      let nextIdx = i + 1
      while (nextIdx < list.length && list[nextIdx].offset === null) nextIdx++
      const startOff = list[i - 1].offset as number
      const endOff = list[nextIdx].offset as number
      const count = nextIdx - i + 1
      for (let k = 0; k < nextIdx - i; k++) {
        list[i + k].offset = startOff + ((endOff - startOff) * (k + 1)) / count
      }
      i = nextIdx
    } else {
      i++
    }
  }

  return list as { color: string; offset: number }[]
}

function parseLinearAngle(dir: string, w: number, h: number): number | null {
  const lower = dir.toLowerCase().trim()
  if (lower.endsWith('deg')) return parseFloat(lower)
  if (lower.endsWith('turn')) return parseFloat(lower) * 360
  if (lower.endsWith('rad')) return (parseFloat(lower) * 180) / Math.PI
  if (!lower.startsWith('to ')) return null

  const parts = new Set(lower.slice(3).trim().split(/\s+/))
  const vx = parts.has('right') ? w : parts.has('left') ? -w : 0
  const vy = parts.has('bottom') ? h : parts.has('top') ? -h : 0
  return vx !== 0 || vy !== 0 ? (Math.atan2(vx, -vy) * 180) / Math.PI : null
}

function computeTileSize(rawSize: string, boxW: number, boxH: number, img?: HTMLImageElement): [number, number] {
  const trimmed = rawSize.trim().toLowerCase()
  if (!trimmed || trimmed === 'auto') {
    return img ? [img.naturalWidth || boxW, img.naturalHeight || boxH] : [boxW, boxH]
  }
  if (trimmed === 'cover' && img && img.naturalWidth > 0) {
    const scale = Math.max(boxW / img.naturalWidth, boxH / img.naturalHeight)
    return [img.naturalWidth * scale, img.naturalHeight * scale]
  }
  if (trimmed === 'contain' && img && img.naturalWidth > 0) {
    const scale = Math.min(boxW / img.naturalWidth, boxH / img.naturalHeight)
    return [img.naturalWidth * scale, img.naturalHeight * scale]
  }
  const parts = trimmed.split(/\s+/)
  const rawW = parts[0]
  const rawH = parts[1] ?? 'auto'
  const aspect = img && img.naturalWidth > 0 ? img.naturalHeight / img.naturalWidth : 1

  let tw = rawW === 'auto' ? NaN : parseLengthPx(rawW, boxW)
  let th = rawH === 'auto' ? NaN : parseLengthPx(rawH, boxH)
  if (Number.isNaN(tw) && Number.isNaN(th)) return [boxW, boxH]
  if (Number.isNaN(tw)) tw = img ? th / aspect : boxW
  if (Number.isNaN(th)) th = img ? tw * aspect : boxH
  return [Math.max(1, tw), Math.max(1, th)]
}

function parseBgPos(rawPos: string, boxW: number, boxH: number, tileW: number, tileH: number): [number, number] {
  const tokens = rawPos.trim().toLowerCase().split(/\s+/)
  const pxToken = POSITION_KEYWORDS[tokens[0]] ?? tokens[0] ?? '0%'
  const pyToken = POSITION_KEYWORDS[tokens[1]] ?? tokens[1] ?? '0%'

  const resolve = (tok: string, boxDim: number, tileDim: number) =>
    tok.endsWith('%') ? (boxDim - tileDim) * (parseFloat(tok) / 100) : parseFloat(tok) || 0
  return [resolve(pxToken, boxW, tileW), resolve(pyToken, boxH, tileH)]
}

function addColorStops(grad: CanvasGradient, stops: { color: string; offset: number }[]): void {
  for (const s of stops) {
    try {
      grad.addColorStop(s.offset, s.color)
    } catch {
      // Unsupported color tokens are skipped to preserve remaining stops.
    }
  }
}

function drawLinearGradient(
  ctx: CanvasRenderingContext2D,
  expr: string,
  w: number,
  h: number,
  isRepeating: boolean,
): void {
  const prefix = isRepeating ? 'repeating-linear-gradient(' : 'linear-gradient('
  const args = splitTopLevel(expr.slice(prefix.length, -1), ',')
  if (!args.length) return

  const parsedAngle = parseLinearAngle(args[0], w, h)
  const angleDeg = parsedAngle ?? 180
  const stopStrings = parsedAngle !== null ? args.slice(1) : args

  const rad = degToRad(angleDeg)
  const dx = Math.sin(rad)
  const dy = -Math.cos(rad)
  const halfLen = (Math.abs(w * dx) + Math.abs(h * dy)) * 0.5
  const cx = w * 0.5
  const cy = h * 0.5

  const grad = ctx.createLinearGradient(cx - dx * halfLen, cy - dy * halfLen, cx + dx * halfLen, cy + dy * halfLen)
  const rawStops = parseStops(stopStrings, halfLen * 2)
  let stops = rawStops

  if (isRepeating && rawStops.length >= 2) {
    const startOff = rawStops[0].offset
    const period = rawStops[rawStops.length - 1].offset - startOff
    if (period > 0.002 && period < 0.99) {
      const tiled: { color: string; offset: number }[] = []
      const reps = Math.min(128, Math.ceil((1 - startOff) / period))
      for (let r = 0; r < reps; r++) {
        const shift = r * period
        for (const s of rawStops) {
          const off = Math.min(1, s.offset + shift)
          tiled.push({ color: s.color, offset: off })
          if (off >= 1) break
        }
      }
      stops = tiled
    }
  }

  addColorStops(grad, stops)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, w, h)
}

function drawRadialGradient(ctx: CanvasRenderingContext2D, expr: string, w: number, h: number): void {
  const args = splitTopLevel(expr.slice('radial-gradient('.length, -1), ',')
  if (!args.length) return

  const first = args[0]
  const hasSpec =
    /(?:^|\s)(circle|ellipse|closest-side|closest-corner|farthest-side|farthest-corner|at)(?:\s|$)/i.test(first) ||
    /^\d/.test(first)
  const spec = hasSpec ? first : ''
  const stopStrings = hasSpec ? args.slice(1) : args

  let cx = w * 0.5
  let cy = h * 0.5
  let sizePart = spec
  const atIdx = spec.toLowerCase().indexOf(' at ')
  if (atIdx !== -1 || spec.toLowerCase().startsWith('at ')) {
    const posStr = spec.slice(atIdx === -1 ? 3 : atIdx + 4).trim()
    sizePart = atIdx === -1 ? '' : spec.slice(0, atIdx).trim()
    const posTokens = posStr.split(/\s+/)
    cx = parseLengthPx(POSITION_KEYWORDS[posTokens[0]?.toLowerCase()] ?? posTokens[0] ?? '50%', w)
    cy = parseLengthPx(POSITION_KEYWORDS[posTokens[1]?.toLowerCase()] ?? posTokens[1] ?? '50%', h)
  }

  let rx = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy))
  let ry = rx
  const sizeTokens = sizePart.replace(/\b(circle|ellipse)\b/gi, '').trim().split(/\s+/).filter(Boolean)
  if (sizeTokens.length === 2 && !sizeTokens[0].endsWith('side') && !sizeTokens[0].endsWith('corner')) {
    rx = Math.max(1, parseLengthPx(sizeTokens[0], w))
    ry = Math.max(1, parseLengthPx(sizeTokens[1], h))
  } else if (sizeTokens.length === 1 && !sizeTokens[0].endsWith('side') && !sizeTokens[0].endsWith('corner')) {
    rx = Math.max(1, parseLengthPx(sizeTokens[0], Math.max(w, h)))
    ry = rx
  } else if (sizePart.includes('closest-side')) {
    rx = Math.max(1, Math.min(cx, w - cx))
    ry = Math.max(1, Math.min(cy, h - cy))
    if (sizePart.includes('circle')) rx = ry = Math.min(rx, ry)
  }

  const stops = parseStops(stopStrings, Math.max(rx, ry))
  if (!stops.length) return

  ctx.save()
  ctx.translate(cx, cy)
  if (Math.abs(ry - rx) > 0.5) {
    ctx.scale(1, ry / rx)
  }
  const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, rx)
  addColorStops(grad, stops)
  ctx.fillStyle = grad
  ctx.fillRect(-cx, -cy * (rx / ry), w, h * (rx / ry))
  ctx.restore()
}

function drawGradientInto(ctx: CanvasRenderingContext2D, expr: string, w: number, h: number): void {
  if (expr.startsWith('linear-gradient(')) {
    drawLinearGradient(ctx, expr, w, h, false)
  } else if (expr.startsWith('repeating-linear-gradient(')) {
    drawLinearGradient(ctx, expr, w, h, true)
  } else if (expr.startsWith('radial-gradient(')) {
    drawRadialGradient(ctx, expr, w, h)
  }
}

function isNoRepeat(repeatSpec: string): boolean {
  return /^no-repeat(?:\s+no-repeat)?$/.test(repeatSpec)
}

function paintBackgroundLayers(
  ctx: CanvasRenderingContext2D,
  cs: CSSStyleDeclaration,
  x: number,
  y: number,
  w: number,
  h: number,
  snapScale: number,
  onAssetReady: () => void,
): void {
  if (!isTransparentColor(cs.backgroundColor)) {
    ctx.fillStyle = cs.backgroundColor
    ctx.fillRect(x, y, w, h)
  }

  const bgImage = cs.backgroundImage
  if (!bgImage || bgImage === 'none') return

  const layers = splitTopLevel(bgImage, ',')
  const sizes = splitTopLevel(cs.backgroundSize || 'auto', ',')
  const positions = splitTopLevel(cs.backgroundPosition || '0% 0%', ',')
  const repeats = splitTopLevel(cs.backgroundRepeat || 'repeat', ',')

  for (let idx = layers.length - 1; idx >= 0; idx--) {
    const layer = layers[idx]
    const sizeSpec = sizes[idx % sizes.length] || 'auto'
    const posSpec = positions[idx % positions.length] || '0% 0%'
    const repeatSpec = (repeats[idx % repeats.length] || 'repeat').toLowerCase()

    if (layer.startsWith('url(')) {
      const rawUrl = layer.slice(4, -1).trim().replace(/^["']|["']$/g, '')
      const img = loadAsset(rawUrl, onAssetReady)
      if (!img) continue
      const [dw, dh] = computeTileSize(sizeSpec, w, h, img)
      const [px, py] = parseBgPos(posSpec, w, h, dw, dh)
      if (isNoRepeat(repeatSpec)) {
        ctx.drawImage(img, x + px, y + py, dw, dh)
      } else {
        const pattern = ctx.createPattern(img, 'repeat')
        if (pattern) {
          ctx.save()
          ctx.translate(x + px, y + py)
          ctx.scale(dw / img.naturalWidth, dh / img.naturalHeight)
          ctx.fillStyle = pattern
          ctx.fillRect(-px * (img.naturalWidth / dw), -py * (img.naturalHeight / dh), w * (img.naturalWidth / dw), h * (img.naturalHeight / dh))
          ctx.restore()
        }
      }
      continue
    }

    if (
      layer.startsWith('linear-gradient(') ||
      layer.startsWith('repeating-linear-gradient(') ||
      layer.startsWith('radial-gradient(')
    ) {
      const [tw, th] = computeTileSize(sizeSpec, w, h)
      const [px, py] = parseBgPos(posSpec, w, h, tw, th)
      if (isNoRepeat(repeatSpec) || (Math.abs(tw - w) < 0.5 && Math.abs(th - h) < 0.5 && Math.abs(px) < 0.5 && Math.abs(py) < 0.5)) {
        ctx.save()
        ctx.translate(x + px, y + py)
        drawGradientInto(ctx, layer, tw, th)
        ctx.restore()
        continue
      }

      const tile = document.createElement('canvas')
      tile.width = Math.max(1, Math.round(tw * snapScale))
      tile.height = Math.max(1, Math.round(th * snapScale))
      const tCtx = tile.getContext('2d')
      if (!tCtx) continue
      tCtx.scale(snapScale, snapScale)
      drawGradientInto(tCtx, layer, tw, th)
      const pattern = ctx.createPattern(tile, 'repeat')
      if (pattern) {
        ctx.save()
        ctx.translate(x + px, y + py)
        if (typeof pattern.setTransform === 'function' && typeof DOMMatrix !== 'undefined') {
          pattern.setTransform(new DOMMatrix().scale(1 / snapScale))
          ctx.fillStyle = pattern
          ctx.fillRect(-px, -py, w, h)
        } else {
          ctx.scale(1 / snapScale, 1 / snapScale)
          ctx.fillStyle = pattern
          ctx.fillRect(-px * snapScale, -py * snapScale, w * snapScale, h * snapScale)
        }
        ctx.restore()
      }
    }
  }
}

function parseTextShadow(raw: string): { color: string; x: number; y: number; blur: number } | null {
  if (!raw || raw === 'none') return null
  const firstShadow = splitTopLevel(raw, ',')[0]
  const tokens = tokenizeTopLevelSpaces(firstShadow)
  let color = 'transparent'
  const nums: number[] = []
  for (const t of tokens) {
    if (/^-?[\d.]+(?:px)?$/i.test(t)) {
      nums.push(parseFloat(t))
    } else {
      color = t
    }
  }
  if (nums.length < 2 || isTransparentColor(color)) return null
  return { color, x: nums[0], y: nums[1], blur: nums[2] ?? 0 }
}

function applyTextTransform(str: string, transform: string): string {
  if (transform === 'uppercase') return str.toUpperCase()
  if (transform === 'lowercase') return str.toLowerCase()
  if (transform === 'capitalize') return str.replace(/\b\w/g, (c) => c.toUpperCase())
  return str
}

function renderTextNode(
  ctx: CanvasRenderingContext2D,
  node: Text,
  cs: CSSStyleDeclaration,
  targetRect: DOMRect,
): void {
  const raw = node.nodeValue
  if (!raw) return
  const trimmedMatch = /\S(?:[\s\S]*\S)?/.exec(raw)
  if (!trimmedMatch) return

  const range = document.createRange()
  range.setStart(node, trimmedMatch.index)
  range.setEnd(node, trimmedMatch.index + trimmedMatch[0].length)
  if (!range.getClientRects().length) return

  ctx.save()
  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
  ctx.fillStyle = cs.color
  ctx.textAlign = 'left'

  if ('letterSpacing' in ctx) {
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing =
      cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing
  }

  const probe = typeof ctx.measureText === 'function' ? ctx.measureText('Mg') : null
  const fontAscent = probe?.fontBoundingBoxAscent
  const fontDescent = probe?.fontBoundingBoxDescent
  const hasFontMetrics =
    typeof fontAscent === 'number' &&
    typeof fontDescent === 'number' &&
    Number.isFinite(fontAscent) &&
    Number.isFinite(fontDescent) &&
    fontAscent + fontDescent > 0
  ctx.textBaseline = hasFontMetrics ? 'alphabetic' : 'middle'
  const baselineRatio = hasFontMetrics ? fontAscent / (fontAscent + fontDescent) : 0.52

  const shadow = parseTextShadow(cs.textShadow)
  const draws: { text: string; x: number; y: number }[] = []
  const wordRegex = /\S+/g
  let match: RegExpExecArray | null

  while ((match = wordRegex.exec(raw)) !== null) {
    const start = match.index
    const end = start + match[0].length
    const rawWord = raw.slice(start, end)
    const wordText = applyTextTransform(rawWord, cs.textTransform)
    if (!wordText) continue

    range.setStart(node, start)
    range.setEnd(node, end)
    const wordRects = range.getClientRects()
    const wordBox = wordRects.length === 1 ? wordRects[0] : range.getBoundingClientRect()
    if (wordBox.width <= 0 || wordBox.height <= 0) continue

    const measuredW = probe ? ctx.measureText(wordText).width : wordBox.width
    const trackingDiverges = Number.isFinite(measuredW) && Math.abs(measuredW - wordBox.width) > 0.6
    const canPerGlyph =
      wordText.length > 1 &&
      wordText.length === rawWord.length &&
      (wordRects.length > 1 || trackingDiverges) &&
      /^[\x21-\x7E\u00C0-\u024F\u2013\u2014]+$/.test(wordText)

    if (canPerGlyph) {
      for (let ci = 0; ci < wordText.length; ci++) {
        range.setStart(node, start + ci)
        range.setEnd(node, start + ci + 1)
        const charBox = range.getBoundingClientRect()
        if (charBox.width <= 0 || charBox.height <= 0) continue
        draws.push({
          text: wordText[ci],
          x: charBox.left - targetRect.left,
          y: charBox.top - targetRect.top + charBox.height * baselineRatio,
        })
      }
    } else {
      draws.push({
        text: wordText,
        x: wordBox.left - targetRect.left,
        y: wordBox.top - targetRect.top + wordBox.height * baselineRatio,
      })
    }
  }

  if (!draws.length) {
    ctx.restore()
    return
  }

  if (shadow) {
    ctx.shadowColor = shadow.color
    ctx.shadowOffsetX = shadow.x
    ctx.shadowOffsetY = shadow.y
    ctx.shadowBlur = shadow.blur
  }
  for (const d of draws) {
    ctx.fillText(d.text, d.x, d.y)
  }

  // Re-stamp opaque glyphs without shadow so adjacent tight-kerned letters do not over-darken each other.
  const isOpaqueText = !/rgba\([^,]+,[^,]+,[^,]+,\s*0\.\d+\)|\/\s*0\.\d+\s*\)/i.test(cs.color)
  if (shadow && isOpaqueText && draws.length > 1) {
    ctx.shadowColor = 'transparent'
    ctx.shadowOffsetX = 0
    ctx.shadowOffsetY = 0
    ctx.shadowBlur = 0
    for (const d of draws) {
      ctx.fillText(d.text, d.x, d.y)
    }
  }

  ctx.restore()
}

function orderedChildElements(parent: Element): Element[] {
  const children = Array.from(parent.children)
  if (children.length <= 1) return children

  const keyed = children.map((el, index) => {
    const zRaw = getComputedStyle(el).zIndex
    return { el, z: zRaw === 'auto' ? 0 : parseInt(zRaw, 10) || 0, index }
  })
  keyed.sort((a, b) => (a.z !== b.z ? a.z - b.z : a.index - b.index))
  return keyed.map((k) => k.el)
}

function paintReplacedElement(
  ctx: CanvasRenderingContext2D,
  el: Element,
  cs: CSSStyleDeclaration,
  x: number,
  y: number,
  w: number,
  h: number,
  radii: [number, number, number, number],
  hasRadius: boolean,
  onAssetReady: () => void,
  onVideoPlaying?: (video: HTMLVideoElement) => void,
): boolean {
  const tag = el.tagName.toUpperCase()

  if (tag === 'IMG') {
    const src = (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src
    const img = src ? loadAsset(src, onAssetReady) : null
    if (img) {
      withRoundedClip(ctx, x, y, w, h, radii, hasRadius, () => ctx.drawImage(img, x, y, w, h))
    }
    return true
  }

  if (tag === 'VIDEO') {
    const video = el as HTMLVideoElement
    if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
      withRoundedClip(ctx, x, y, w, h, radii, hasRadius, () => {
        if (cs.objectFit === 'cover') {
          const ir = video.videoWidth / video.videoHeight
          const br = w / h
          const dw = ir > br ? h * ir : w
          const dh = ir > br ? h : w / ir
          ctx.drawImage(video, x + (w - dw) * 0.5, y + (h - dh) * 0.5, dw, dh)
        } else {
          ctx.drawImage(video, x, y, w, h)
        }
      })
      if (!video.paused && !video.ended) {
        if (onVideoPlaying) onVideoPlaying(video)
        else onAssetReady()
      }
    }
    return true
  }

  if (tag === 'CANVAS') {
    const cvs = el as HTMLCanvasElement
    if (cvs.width > 0 && cvs.height > 0) {
      withRoundedClip(ctx, x, y, w, h, radii, hasRadius, () => ctx.drawImage(cvs, x, y, w, h))
    }
    return true
  }

  if (tag === 'SVG') {
    const clone = el.cloneNode(true) as SVGSVGElement
    if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    clone.setAttribute('width', String(Math.round(w)))
    clone.setAttribute('height', String(Math.round(h)))
    const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(clone))}`
    const img = loadAsset(svgUrl, onAssetReady)
    if (img) ctx.drawImage(img, x, y, w, h)
    return true
  }

  return false
}

function paintElementTree(
  ctx: CanvasRenderingContext2D,
  el: Element,
  targetRect: DOMRect,
  snapScale: number,
  onAssetReady: () => void,
  isRootTarget: boolean,
  onVideoPlaying?: (video: HTMLVideoElement) => void,
  skipElements?: Set<Element>,
): void {
  if (skipElements?.has(el)) return
  if (!isRootTarget && !skipElements && (el.hasAttribute('data-lg-root') || el.hasAttribute('data-lg-ignore'))) {
    return
  }

  const cs = getComputedStyle(el)
  if (cs.display === 'none' || cs.visibility === 'hidden') return
  const opacity = parseFloat(cs.opacity)
  if (Number.isFinite(opacity) && opacity <= 0.001) return

  const rect = el.getBoundingClientRect()
  const x = rect.left - targetRect.left
  const y = rect.top - targetRect.top
  const w = rect.width
  const h = rect.height
  if (w <= 0 || h <= 0) return

  const radii = parseCornerRadii(cs, w, h)
  const hasRadius = radii[0] > 0 || radii[1] > 0 || radii[2] > 0 || radii[3] > 0

  ctx.save()
  if (Number.isFinite(opacity) && opacity < 0.999) {
    ctx.globalAlpha *= opacity
  }

  withRoundedClip(ctx, x, y, w, h, radii, hasRadius, () => {
    paintBackgroundLayers(ctx, cs, x, y, w, h, snapScale, onAssetReady)
  })

  const borderW = parseFloat(cs.borderTopWidth) || 0
  if (borderW > 0 && cs.borderTopStyle !== 'none' && !isTransparentColor(cs.borderTopColor)) {
    ctx.save()
    traceRoundedRect(ctx, x + borderW * 0.5, y + borderW * 0.5, Math.max(0, w - borderW), Math.max(0, h - borderW), radii)
    ctx.strokeStyle = cs.borderTopColor
    ctx.lineWidth = borderW
    ctx.stroke()
    ctx.restore()
  }

  if (paintReplacedElement(ctx, el, cs, x, y, w, h, radii, hasRadius, onAssetReady, onVideoPlaying)) {
    ctx.restore()
    return
  }

  const clipsChildren =
    cs.overflow === 'hidden' || cs.overflow === 'clip' || cs.overflowX === 'hidden' || cs.overflowY === 'hidden'
  if (clipsChildren) {
    traceRoundedRect(ctx, x, y, w, h, radii)
    ctx.clip()
  }

  for (const child of el.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      renderTextNode(ctx, child as Text, cs, targetRect)
    }
  }
  for (const childEl of orderedChildElements(el)) {
    paintElementTree(ctx, childEl, targetRect, snapScale, onAssetReady, false, onVideoPlaying, skipElements)
  }

  ctx.restore()
}

function hasVisibleConsumer(entry: SnapshotEntry): boolean {
  if (entry.consumers.size === 0) return true
  for (const rec of entry.consumers.values()) {
    const el = rec.rootEl
    if (!el) return true
    const check = (
      el as HTMLElement & {
        checkVisibility?: (opts?: { checkOpacity?: boolean; checkVisibilityCSS?: boolean }) => boolean
      }
    ).checkVisibility
    if (typeof check !== 'function' || check.call(el, { checkOpacity: true, checkVisibilityCSS: true })) {
      return true
    }
  }
  return false
}

function isTargetActive(entry: SnapshotEntry): boolean {
  if (!entry.isVisible) return false
  if (typeof document !== 'undefined' && document.hidden) return false
  return hasVisibleConsumer(entry)
}

function scheduleVideoFrame(entry: SnapshotEntry, video: HTMLVideoElement): void {
  entry.hasActiveVideo = true
  if (!isTargetActive(entry)) {
    entry.deferredWhileHidden = true
    return
  }
  const rvfc = (video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number })
    .requestVideoFrameCallback
  if (typeof rvfc !== 'function') {
    scheduleSnapshotRefresh(entry)
    return
  }
  if (entry.videoCallbacks.has(video)) return
  entry.videoCallbacks.add(video)
  rvfc.call(video, () => {
    entry.videoCallbacks.delete(video)
    if (!snapshotRegistry.has(entry.target)) return
    if (!isTargetActive(entry)) {
      entry.deferredWhileHidden = true
      return
    }
    if (nowMs() - entry.lastVideoCaptureAt < MIN_VIDEO_CAPTURE_INTERVAL_MS) {
      if (!video.paused && !video.ended) scheduleVideoFrame(entry, video)
      return
    }
    scheduleSnapshotRefresh(entry)
  })
}

function createTargetSnapshot(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  version: number,
  width: number,
  height: number,
  scale: number,
  cssWidth: number,
  cssHeight: number,
): TargetSnapshot {
  let cachedData: Uint8ClampedArray | null = null
  let dataFailed = false

  return {
    canvas,
    version,
    width,
    height,
    scale,
    cssWidth,
    cssHeight,
    get data(): Uint8ClampedArray {
      if (cachedData) return cachedData
      if (dataFailed) return new Uint8ClampedArray(0)
      try {
        cachedData = ctx.getImageData(0, 0, width, height).data
        return cachedData
      } catch {
        dataFailed = true
        return new Uint8ClampedArray(0)
      }
    },
  }
}

function resolveGlassScope(rootEl: HTMLElement, targetEl: HTMLElement): HTMLElement {
  let cur: HTMLElement | null = rootEl.parentElement
  while (cur && cur !== targetEl) {
    if (cur.hasAttribute('data-lg-root')) return rootEl
    if (cur.hasAttribute('data-lg-ignore')) return cur
    cur = cur.parentElement
  }
  return rootEl
}

function getStackingPath(el: HTMLElement, root: HTMLElement): { el: HTMLElement; z: number }[] {
  const path: { el: HTMLElement; z: number }[] = []
  let cur: HTMLElement | null = el
  while (cur && cur !== root) {
    const cs = getComputedStyle(cur)
    const z = cs.zIndex !== 'auto' ? parseInt(cs.zIndex, 10) || 0 : 0
    const createsSc =
      (cs.position !== 'static' && cs.zIndex !== 'auto') ||
      cs.position === 'fixed' ||
      cs.position === 'sticky' ||
      parseFloat(cs.opacity) < 0.999 ||
      cs.transform !== 'none' ||
      cs.isolation === 'isolate' ||
      cs.filter !== 'none' ||
      cs.backdropFilter !== 'none'
    if (cur === el || createsSc || cs.zIndex !== 'auto') {
      path.push({ el: cur, z })
    }
    cur = cur.parentElement
  }
  path.reverse()
  return path
}

function comparePaintOrder(a: HTMLElement, b: HTMLElement, root: HTMLElement): number {
  if (a === b) return 0
  if (a.contains(b)) return -1
  if (b.contains(a)) return 1

  const pathA = getStackingPath(a, root)
  const pathB = getStackingPath(b, root)
  const len = Math.min(pathA.length, pathB.length)

  for (let i = 0; i < len; i++) {
    if (pathA[i].el === pathB[i].el) continue
    if (pathA[i].z !== pathB[i].z) return pathA[i].z - pathB[i].z
    return pathA[i].el.compareDocumentPosition(pathB[i].el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
  }
  return pathA.length - pathB.length
}

function rectsOverlap(a: DOMRect, b: DOMRect, margin: number): boolean {
  return (
    a.left < b.right + margin &&
    a.right > b.left - margin &&
    a.top < b.bottom + margin &&
    a.bottom > b.top - margin
  )
}

function getScopeRect(rec: ConsumerRecord, now: number): DOMRect | null {
  if (!rec.scopeEl) return null
  if (rec.cachedRect && now - rec.cachedRectAt < SCOPE_RECT_CACHE_TTL_MS) return rec.cachedRect
  const rect = rec.scopeEl.getBoundingClientRect()
  rec.cachedRect = rect
  rec.cachedRectAt = now
  return rect
}

function getOrderedConsumers(entry: SnapshotEntry): ConsumerRecord[] {
  const list = Array.from(entry.consumers.values())
  if (list.length <= 1 || list.length > MAX_SORTED_CONSUMERS) return list
  list.sort((a, b) => {
    if (!a.scopeEl || !b.scopeEl) return 0
    return comparePaintOrder(a.scopeEl, b.scopeEl, entry.target)
  })
  return list
}

function notifyScopesAbove(entry: SnapshotEntry, scopes: Iterable<HTMLElement>): void {
  const scopeSet = new Set(scopes)
  if (scopeSet.size === 0 || entry.consumers.size <= 1) return

  const now = nowMs()
  const scopeRects = new Map<HTMLElement, DOMRect>()
  for (const s of scopeSet) {
    scopeRects.set(s, s.getBoundingClientRect())
  }

  const toNotify: ConsumerRecord[] = []
  for (const rec of entry.consumers.values()) {
    if (!rec.scopeEl) continue
    const recRect = getScopeRect(rec, now)
    if (!recRect) continue
    for (const scopeEl of scopeSet) {
      if (rec.scopeEl === scopeEl) continue
      const scopeRect = scopeRects.get(scopeEl)!
      const overlaps =
        rec.lastOverlappedScopes.has(scopeEl) ||
        rectsOverlap(scopeRect, recRect, OVERLAP_MARGIN_PX)
      if (overlaps && comparePaintOrder(scopeEl, rec.scopeEl, entry.target) < 0) {
        toNotify.push(rec)
        break
      }
    }
  }

  if (toNotify.length > 1) {
    toNotify.sort((a, b) => comparePaintOrder(a.scopeEl!, b.scopeEl!, entry.target))
  }
  for (const rec of toNotify) {
    rec.onUpdate()
  }
}

function captureSnapshotNow(entry: SnapshotEntry): void {
  entry.rafId = 0
  entry.deferredWhileHidden = false
  const rect = entry.target.getBoundingClientRect()
  const cssW = Math.max(0, Math.round(rect.width))
  const cssH = Math.max(0, Math.round(rect.height))
  if (cssW < 2 || cssH < 2) {
    entry.snapshot = null
    return
  }

  const maxScale = entry.hasActiveVideo ? 1 : 2
  const maxDim = entry.hasActiveVideo ? MAX_VIDEO_SNAP_DIM : MAX_SNAP_DIM
  const rawDpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, maxScale) : 1
  const capScale = Math.min(rawDpr, maxDim / cssW, maxDim / cssH)
  const minScale = entry.hasActiveVideo ? 0.5 : 1
  const scale = Math.max(minScale, Math.min(rawDpr, capScale > 0 ? capScale : 1))
  const bufW = Math.max(2, Math.round(cssW * scale))
  const bufH = Math.max(2, Math.round(cssH * scale))

  if (entry.canvas.width !== bufW) entry.canvas.width = bufW
  if (entry.canvas.height !== bufH) entry.canvas.height = bufH

  const ctx = entry.ctx
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, bufW, bufH)
  ctx.setTransform(scale, 0, 0, scale, 0, 0)

  entry.hasActiveVideo = false
  paintElementTree(
    ctx,
    entry.target,
    rect,
    scale,
    () => scheduleSnapshotRefresh(entry),
    true,
    (video) => scheduleVideoFrame(entry, video),
  )
  if (entry.hasActiveVideo) {
    entry.lastVideoCaptureAt = nowMs()
  }

  entry.version += 1
  entry.snapshot = createTargetSnapshot(entry.canvas, ctx, entry.version, bufW, bufH, scale, cssW, cssH)

  for (const rec of getOrderedConsumers(entry)) {
    rec.onUpdate()
  }
}

function scheduleSnapshotRefresh(entry: SnapshotEntry): void {
  if (!isTargetActive(entry)) {
    entry.deferredWhileHidden = true
    return
  }
  if (entry.rafId || typeof requestAnimationFrame === 'undefined') return
  entry.rafId = requestAnimationFrame(() => captureSnapshotNow(entry))
}

function scheduleDirtyScopeNotify(entry: SnapshotEntry, scopeEl: HTMLElement): void {
  entry.dirtyScopes.add(scopeEl)
  if (entry.dirtyScopeRaf || typeof requestAnimationFrame === 'undefined') return
  entry.dirtyScopeRaf = requestAnimationFrame(() => {
    entry.dirtyScopeRaf = 0
    if (entry.dirtyScopes.size === 0) return
    const scopes = Array.from(entry.dirtyScopes)
    entry.dirtyScopes.clear()
    notifyScopesAbove(entry, scopes)
  })
}

function releaseConsumerBuffers(rec: ConsumerRecord): void {
  if (rec.compCanvas) {
    rec.compCanvas.width = 0
    rec.compCanvas.height = 0
    rec.compCanvas = null
    rec.compCtx = null
  }
  rec.compSnapshot = null
}

function buildCompositedSnapshot(
  entry: SnapshotEntry,
  target: HTMLElement,
  base: TargetSnapshot,
  consumerRec: ConsumerRecord,
  lowerScopes: HTMLElement[],
  skipElements: Set<Element>,
): TargetSnapshot {
  lowerScopes.sort((a, b) => comparePaintOrder(a, b, target))

  if (!consumerRec.compCanvas) {
    consumerRec.compCanvas = document.createElement('canvas')
    consumerRec.compCtx = consumerRec.compCanvas.getContext('2d')
  }
  const compCanvas = consumerRec.compCanvas
  const compCtx = consumerRec.compCtx
  if (!compCtx) return base

  if (compCanvas.width !== base.width) compCanvas.width = base.width
  if (compCanvas.height !== base.height) compCanvas.height = base.height

  compCtx.setTransform(1, 0, 0, 1, 0, 0)
  compCtx.clearRect(0, 0, base.width, base.height)
  compCtx.drawImage(base.canvas, 0, 0)
  compCtx.setTransform(base.scale, 0, 0, base.scale, 0, 0)

  const targetRect = target.getBoundingClientRect()
  const schedule = () => scheduleSnapshotRefresh(entry)
  const onVideoPlaying = (video: HTMLVideoElement) => scheduleVideoFrame(entry, video)

  for (const lowerScope of lowerScopes) {
    paintElementTree(compCtx, lowerScope, targetRect, base.scale, schedule, true, onVideoPlaying, skipElements)
  }

  consumerRec.compVersion += 1
  consumerRec.compSnapshot = createTargetSnapshot(
    compCanvas,
    compCtx,
    consumerRec.compVersion,
    base.width,
    base.height,
    base.scale,
    base.cssWidth,
    base.cssHeight,
  )
  return consumerRec.compSnapshot
}

export function getTargetSnapshot(target: HTMLElement, rootEl?: HTMLElement | null): TargetSnapshot | null {
  const entry = snapshotRegistry.get(target)
  if (!entry) return null
  if (entry.deferredWhileHidden && isTargetActive(entry)) {
    entry.deferredWhileHidden = false
    scheduleSnapshotRefresh(entry)
  }
  if (!entry.snapshot) return null
  const base = entry.snapshot

  if (!rootEl || entry.consumers.size <= 1) return base

  const consumerScope = resolveGlassScope(rootEl, target)
  let consumerRec: ConsumerRecord | undefined
  for (const rec of entry.consumers.values()) {
    if (rec.rootEl === rootEl) {
      consumerRec = rec
      break
    }
  }
  if (!consumerRec) return base

  const now = nowMs()
  const consumerRect = getScopeRect(consumerRec, now) ?? consumerScope.getBoundingClientRect()
  const lowerScopes: HTMLElement[] = []
  const seenScopes = new Set<HTMLElement>()
  const skipElements = new Set<Element>([consumerScope, rootEl])

  for (const rec of entry.consumers.values()) {
    const otherScope = rec.scopeEl
    if (!otherScope || otherScope === consumerScope) continue
    const otherRect = getScopeRect(rec, now)
    if (!otherRect || !rectsOverlap(otherRect, consumerRect, OVERLAP_MARGIN_PX)) continue

    if (comparePaintOrder(otherScope, consumerScope, target) >= 0) {
      skipElements.add(otherScope)
      continue
    }
    if (seenScopes.has(otherScope)) continue
    seenScopes.add(otherScope)
    lowerScopes.push(otherScope)
  }

  consumerRec.lastOverlappedScopes = new Set(lowerScopes)
  if (lowerScopes.length === 0) {
    releaseConsumerBuffers(consumerRec)
    return base
  }

  return buildCompositedSnapshot(entry, target, base, consumerRec, lowerScopes, skipElements)
}

export function notifyGlassRedrawn(target: HTMLElement, rootEl: HTMLElement | null): void {
  const entry = snapshotRegistry.get(target)
  if (!entry || !rootEl || entry.consumers.size <= 1) return
  const scopeEl = resolveGlassScope(rootEl, target)
  if (entry.notifyingScopes.has(scopeEl)) return
  entry.notifyingScopes.add(scopeEl)
  try {
    notifyScopesAbove(entry, [scopeEl])
  } finally {
    entry.notifyingScopes.delete(scopeEl)
  }
}

/**
 * Registers a consumer for a shared offscreen DOM backdrop snapshot of `target`.
 * Multiple `<LiquidGlass />` components targeting the same scene share one snapshot buffer.
 */
export function subscribeTargetSnapshot(
  target: HTMLElement,
  onUpdate: () => void,
  rootEl?: HTMLElement | null,
): () => void {
  if (
    typeof document === 'undefined' ||
    typeof ResizeObserver === 'undefined' ||
    typeof MutationObserver === 'undefined'
  ) {
    return () => {}
  }

  let entry = snapshotRegistry.get(target)
  if (!entry) {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) return () => {}

    const created: SnapshotEntry = {
      target,
      canvas,
      ctx,
      snapshot: null,
      version: 0,
      isVisible: true,
      deferredWhileHidden: false,
      hasActiveVideo: false,
      lastVideoCaptureAt: 0,
      videoCallbacks: new WeakSet(),
      consumers: new Map(),
      notifyingScopes: new Set(),
      dirtyScopes: new Set(),
      dirtyScopeRaf: 0,
      rafId: 0,
      io: null,
      onMedia: () => scheduleSnapshotRefresh(created),
      onVisibilityChange: () => {
        if (isTargetActive(created) && created.deferredWhileHidden) {
          created.deferredWhileHidden = false
          scheduleSnapshotRefresh(created)
        }
      },
      ro: new ResizeObserver(() => scheduleSnapshotRefresh(created)),
      mo: new MutationObserver((records) => {
        for (const rec of records) {
          const el = rec.target instanceof Element ? rec.target : rec.target.parentElement
          if (!el || el.closest('[data-lg-root]')) continue
          const ignoredScope = el.closest('[data-lg-ignore]')
          if (ignoredScope instanceof HTMLElement && ignoredScope !== created.target) {
            scheduleDirtyScopeNotify(created, ignoredScope)
            continue
          }
          scheduleSnapshotRefresh(created)
          break
        }
      }),
    }

    if (typeof IntersectionObserver !== 'undefined') {
      created.io = new IntersectionObserver(
        (entries) => {
          const hit = entries[entries.length - 1]
          if (!hit) return
          created.isVisible = hit.isIntersecting
          if (hit.isIntersecting && created.deferredWhileHidden && !document.hidden) {
            created.deferredWhileHidden = false
            scheduleSnapshotRefresh(created)
          }
        },
        { rootMargin: SNAPSHOT_ROOT_MARGIN },
      )
      created.io.observe(target)
    }

    created.ro.observe(target)
    created.mo.observe(target, { childList: true, subtree: true, attributes: true, characterData: true })
    target.addEventListener('loadeddata', created.onMedia, true)
    target.addEventListener('play', created.onMedia, true)
    target.addEventListener('seeked', created.onMedia, true)
    document.addEventListener('visibilitychange', created.onVisibilityChange)

    if (document.fonts?.ready) {
      void document.fonts.ready.then(() => {
        if (snapshotRegistry.has(target)) scheduleSnapshotRefresh(created)
      })
    }

    snapshotRegistry.set(target, created)
    captureSnapshotNow(created)
    entry = created
    notifySnapshotStats()
  }

  const resolvedRoot = rootEl ?? null
  entry.consumers.set(onUpdate, {
    onUpdate,
    rootEl: resolvedRoot,
    scopeEl: resolvedRoot ? resolveGlassScope(resolvedRoot, target) : null,
    compCanvas: null,
    compCtx: null,
    compVersion: 0,
    compSnapshot: null,
    lastOverlappedScopes: new Set(),
    cachedRect: null,
    cachedRectAt: 0,
  })
  if (!entry.snapshot) captureSnapshotNow(entry)

  return () => {
    const cur = snapshotRegistry.get(target)
    if (!cur) return
    const rec = cur.consumers.get(onUpdate)
    if (rec) {
      releaseConsumerBuffers(rec)
      cur.consumers.delete(onUpdate)
    }
    if (cur.consumers.size === 0) {
      if (cur.rafId && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(cur.rafId)
      if (cur.dirtyScopeRaf && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(cur.dirtyScopeRaf)
      cur.ro.disconnect()
      cur.mo.disconnect()
      cur.io?.disconnect()
      target.removeEventListener('loadeddata', cur.onMedia, true)
      target.removeEventListener('play', cur.onMedia, true)
      target.removeEventListener('seeked', cur.onMedia, true)
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', cur.onVisibilityChange)
      }
      releaseWebGLSnapshot(cur.canvas)
      cur.canvas.width = 0
      cur.canvas.height = 0
      snapshotRegistry.delete(target)
      notifySnapshotStats()
    }
  }
}
