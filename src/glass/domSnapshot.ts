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

interface SnapshotEntry {
  target: HTMLElement
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  snapshot: TargetSnapshot | null
  version: number
  isVisible: boolean
  deferredWhileHidden: boolean
  videoCallbacks: WeakSet<HTMLVideoElement>
  consumers: Set<() => void>
  ro: ResizeObserver
  mo: MutationObserver
  io: IntersectionObserver | null
  onMedia: () => void
  onVisibilityChange: () => void
  rafId: number
  fontsHooked: boolean
}

const MAX_SNAP_DIM = 2200
const assetCache = new Map<string, AssetEntry>()
const snapshotRegistry = new Map<HTMLElement, SnapshotEntry>()
const statsListeners = new Set<() => void>()

export function getSnapshotCount(): number {
  return snapshotRegistry.size
}

export function subscribeSnapshotStats(listener: () => void): () => void {
  statsListeners.add(listener)
  return () => statsListeners.delete(listener)
}

function notifySnapshotStats(): void {
  for (const listener of statsListeners) listener()
}

export function isTransparent(color: string): boolean {
  if (!color || color === 'transparent') return true
  const m = /^rgba?\(([^)]+)\)$/i.exec(color.trim())
  if (!m) return false
  const body = m[1]
  if (body.includes('/')) {
    const alpha = parseFloat(body.split('/')[1])
    return Number.isFinite(alpha) && alpha <= 0.001
  }
  const parts = body.split(',')
  if (parts.length === 4) {
    const alpha = parseFloat(parts[3])
    return Number.isFinite(alpha) && alpha <= 0.001
  }
  return false
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

function loadAsset(url: string, onReady: () => void): HTMLImageElement | null {
  const cached = assetCache.get(url)
  if (cached) {
    if (cached.status === 'ready') return cached.img
    if (cached.status === 'loading') cached.waiters.add(onReady)
    return null
  }

  const img = new Image()
  const isDataOrBlob = url.startsWith('data:') || url.startsWith('blob:')
  if (!isDataOrBlob && typeof window !== 'undefined') {
    try {
      const resolved = new URL(url, window.location.href)
      if (resolved.origin !== window.location.origin) {
        img.crossOrigin = 'anonymous'
      }
    } catch {
      // ignore malformed URL
    }
  }

  const entry: AssetEntry = { status: 'loading', img, waiters: new Set([onReady]) }
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

function parseLength(raw: string, refSize: number): number {
  const trimmed = raw.trim()
  const val = parseFloat(trimmed)
  if (!Number.isFinite(val)) return 0
  if (trimmed.endsWith('%')) return (val / 100) * refSize
  return val
}

function parseCornerRadii(cs: CSSStyleDeclaration, w: number, h: number): [number, number, number, number] {
  const ref = Math.min(w, h)
  const rTL = Math.min(ref * 0.5, Math.max(0, parseLength(cs.borderTopLeftRadius.split(/\s+/)[0] || '0', w)))
  const rTR = Math.min(ref * 0.5, Math.max(0, parseLength(cs.borderTopRightRadius.split(/\s+/)[0] || '0', w)))
  const rBR = Math.min(ref * 0.5, Math.max(0, parseLength(cs.borderBottomRightRadius.split(/\s+/)[0] || '0', w)))
  const rBL = Math.min(ref * 0.5, Math.max(0, parseLength(cs.borderBottomLeftRadius.split(/\s+/)[0] || '0', w)))
  return [rTL, rTR, rBR, rBL]
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
      list.push({ color, offset: Math.max(0, Math.min(1, off)) })
    }
  }
  if (!list.length) return []

  if (list[0].offset === null) list[0].offset = 0
  if (list[list.length - 1].offset === null) list[list.length - 1].offset = 1

  let prevVal = 0
  for (let i = 0; i < list.length; i++) {
    if (list[i].offset !== null) {
      const clamped = Math.max(prevVal, list[i].offset as number)
      list[i].offset = clamped
      prevVal = clamped
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
  if (lower.startsWith('to ')) {
    const parts = new Set(lower.slice(3).trim().split(/\s+/))
    const hasTop = parts.has('top')
    const hasBottom = parts.has('bottom')
    const hasLeft = parts.has('left')
    const hasRight = parts.has('right')
    let vx = 0
    let vy = 0
    if (hasRight) vx = w
    if (hasLeft) vx = -w
    if (hasTop) vy = -h
    if (hasBottom) vy = h
    if (vx !== 0 || vy !== 0) {
      return (Math.atan2(vx, -vy) * 180) / Math.PI
    }
  }
  return null
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

  let tw = rawW === 'auto' ? NaN : parseLength(rawW, boxW)
  let th = rawH === 'auto' ? NaN : parseLength(rawH, boxH)
  if (Number.isNaN(tw) && Number.isNaN(th)) return [boxW, boxH]
  if (Number.isNaN(tw)) tw = img ? th / aspect : boxW
  if (Number.isNaN(th)) th = img ? tw * aspect : boxH
  return [Math.max(1, tw), Math.max(1, th)]
}

function parseBgPos(rawPos: string, boxW: number, boxH: number, tileW: number, tileH: number): [number, number] {
  const tokens = rawPos.trim().toLowerCase().split(/\s+/)
  const kw: Record<string, string> = { left: '0%', center: '50%', right: '100%', top: '0%', bottom: '100%' }
  const pxToken = kw[tokens[0]] ?? tokens[0] ?? '0%'
  const pyToken = kw[tokens[1]] ?? tokens[1] ?? '0%'

  const resolve = (tok: string, boxDim: number, tileDim: number) => {
    if (tok.endsWith('%')) return (boxDim - tileDim) * (parseFloat(tok) / 100)
    return parseFloat(tok) || 0
  }
  return [resolve(pxToken, boxW, tileW), resolve(pyToken, boxH, tileH)]
}

function drawGradientInto(
  ctx: CanvasRenderingContext2D,
  expr: string,
  w: number,
  h: number,
): void {
  if (expr.startsWith('linear-gradient(')) {
    const inner = expr.slice('linear-gradient('.length, -1)
    const args = splitTopLevel(inner, ',')
    if (!args.length) return
    const parsedAngle = parseLinearAngle(args[0], w, h)
    const angleDeg = parsedAngle !== null ? parsedAngle : 180
    const stopStrings = parsedAngle !== null ? args.slice(1) : args

    const rad = (angleDeg * Math.PI) / 180
    const dx = Math.sin(rad)
    const dy = -Math.cos(rad)
    const halfLen = (Math.abs(w * dx) + Math.abs(h * dy)) * 0.5
    const cx = w * 0.5
    const cy = h * 0.5

    const grad = ctx.createLinearGradient(cx - dx * halfLen, cy - dy * halfLen, cx + dx * halfLen, cy + dy * halfLen)
    const stops = parseStops(stopStrings, halfLen * 2)
    for (const s of stops) {
      try {
        grad.addColorStop(s.offset, s.color)
      } catch {
        // ignore unsupported color tokens
      }
    }
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, w, h)
    return
  }

  if (expr.startsWith('radial-gradient(')) {
    const inner = expr.slice('radial-gradient('.length, -1)
    const args = splitTopLevel(inner, ',')
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
      const kw: Record<string, string> = { left: '0%', center: '50%', right: '100%', top: '0%', bottom: '100%' }
      cx = parseLength(kw[posTokens[0]?.toLowerCase()] ?? posTokens[0] ?? '50%', w)
      cy = parseLength(kw[posTokens[1]?.toLowerCase()] ?? posTokens[1] ?? '50%', h)
    }

    let rx = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy))
    let ry = rx
    const sizeTokens = sizePart.replace(/\b(circle|ellipse)\b/gi, '').trim().split(/\s+/).filter(Boolean)
    if (sizeTokens.length === 2 && !sizeTokens[0].endsWith('side') && !sizeTokens[0].endsWith('corner')) {
      rx = Math.max(1, parseLength(sizeTokens[0], w))
      ry = Math.max(1, parseLength(sizeTokens[1], h))
    } else if (sizeTokens.length === 1 && !sizeTokens[0].endsWith('side') && !sizeTokens[0].endsWith('corner')) {
      rx = Math.max(1, parseLength(sizeTokens[0], Math.max(w, h)))
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
    for (const s of stops) {
      try {
        grad.addColorStop(s.offset, s.color)
      } catch {
        // ignore unsupported color tokens
      }
    }
    ctx.fillStyle = grad
    ctx.fillRect(-cx, -cy * (rx / ry), w, h * (rx / ry))
    ctx.restore()
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
  if (!isTransparent(cs.backgroundColor)) {
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

    if (layer.startsWith('linear-gradient(') || layer.startsWith('radial-gradient(')) {
      const [tw, th] = computeTileSize(sizeSpec, w, h)
      const [px, py] = parseBgPos(posSpec, w, h, tw, th)
      if (isNoRepeat(repeatSpec) || (Math.abs(tw - w) < 0.5 && Math.abs(th - h) < 0.5 && Math.abs(px) < 0.5 && Math.abs(py) < 0.5)) {
        ctx.save()
        ctx.translate(x + px, y + py)
        drawGradientInto(ctx, layer, tw, th)
        ctx.restore()
      } else {
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
  if (nums.length < 2 || isTransparent(color)) return null
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
  const rects = range.getClientRects()
  if (!rects.length) return

  ctx.save()
  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
  ctx.fillStyle = cs.color
  ctx.textAlign = 'left'

  if ('letterSpacing' in ctx) {
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing =
      cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing
  }

  // Match DOM inline baseline via font metrics so large display letters match Canvas2D sub-pixel Y
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
  const words: { start: number; end: number }[] = []
  const re = /\S+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    words.push({ start: m.index, end: m.index + m[0].length })
  }
  if (!words.length) {
    ctx.restore()
    return
  }

  // Position every word (and divergent-tracking Latin glyphs) at exact DOM Range coordinates
  const draws: { text: string; x: number; y: number }[] = []
  for (let wi = 0; wi < words.length; wi++) {
    const word = words[wi]
    const rawWord = raw.slice(word.start, word.end)
    const wordText = applyTextTransform(rawWord, cs.textTransform)
    if (!wordText) continue

    range.setStart(node, word.start)
    range.setEnd(node, word.end)
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
        range.setStart(node, word.start + ci)
        range.setEnd(node, word.start + ci + 1)
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

  if (shadow) {
    ctx.shadowColor = shadow.color
    ctx.shadowOffsetX = shadow.x
    ctx.shadowOffsetY = shadow.y
    ctx.shadowBlur = shadow.blur
  }
  for (let i = 0; i < draws.length; i++) {
    const d = draws[i]
    ctx.fillText(d.text, d.x, d.y)
  }

  // Re-stamp opaque fills over shadow pass so neighboring tight-kerned glyphs don't darken each other
  const isOpaqueText = !/rgba\([^,]+,[^,]+,[^,]+,\s*0\.\d+\)|\/\s*0\.\d+\s*\)/i.test(cs.color)
  if (shadow && isOpaqueText && draws.length > 1) {
    ctx.shadowColor = 'transparent'
    ctx.shadowOffsetX = 0
    ctx.shadowOffsetY = 0
    ctx.shadowBlur = 0
    for (let i = 0; i < draws.length; i++) {
      const d = draws[i]
      ctx.fillText(d.text, d.x, d.y)
    }
  }

  ctx.restore()
}

function orderedChildElements(parent: Element): Element[] {
  const children = Array.from(parent.children)
  if (children.length <= 1) return children

  const keyed = children.map((el, index) => {
    const cs = getComputedStyle(el)
    const zRaw = cs.zIndex
    const zNum = zRaw === 'auto' ? 0 : parseInt(zRaw, 10) || 0
    return { el, z: zNum, index }
  })
  keyed.sort((a, b) => (a.z !== b.z ? a.z - b.z : a.index - b.index))
  return keyed.map((k) => k.el)
}

function paintElementTree(
  ctx: CanvasRenderingContext2D,
  el: Element,
  targetRect: DOMRect,
  snapScale: number,
  onAssetReady: () => void,
  isRootTarget: boolean,
  onVideoPlaying?: (video: HTMLVideoElement) => void,
): void {
  if (!isRootTarget && (el.hasAttribute('data-lg-root') || el.hasAttribute('data-lg-ignore'))) {
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
  const clipsChildren = cs.overflow === 'hidden' || cs.overflow === 'clip' || cs.overflowX === 'hidden' || cs.overflowY === 'hidden'

  ctx.save()
  if (Number.isFinite(opacity) && opacity < 0.999) {
    ctx.globalAlpha *= opacity
  }

  // Paint element's own background clipped to border radius
  ctx.save()
  if (hasRadius) {
    traceRoundedRect(ctx, x, y, w, h, radii)
    ctx.clip()
  }
  paintBackgroundLayers(ctx, cs, x, y, w, h, snapScale, onAssetReady)
  ctx.restore()

  // Border stroke
  const borderW = parseFloat(cs.borderTopWidth) || 0
  if (borderW > 0 && cs.borderTopStyle !== 'none' && !isTransparent(cs.borderTopColor)) {
    ctx.save()
    traceRoundedRect(ctx, x + borderW * 0.5, y + borderW * 0.5, Math.max(0, w - borderW), Math.max(0, h - borderW), radii)
    ctx.strokeStyle = cs.borderTopColor
    ctx.lineWidth = borderW
    ctx.stroke()
    ctx.restore()
  }

  // Inline <img>, <video>, <canvas>, or <svg>
  const tag = el.tagName.toUpperCase()
  if (tag === 'IMG') {
    const src = (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src
    const img = src ? loadAsset(src, onAssetReady) : null
    if (img) {
      ctx.save()
      if (hasRadius) {
        traceRoundedRect(ctx, x, y, w, h, radii)
        ctx.clip()
      }
      ctx.drawImage(img, x, y, w, h)
      ctx.restore()
    }
    ctx.restore()
    return
  }

  if (tag === 'VIDEO') {
    const video = el as HTMLVideoElement
    if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
      ctx.save()
      if (hasRadius) {
        traceRoundedRect(ctx, x, y, w, h, radii)
        ctx.clip()
      }
      if (cs.objectFit === 'cover') {
        const ir = video.videoWidth / video.videoHeight
        const br = w / h
        let dw = w
        let dh = h
        let dx = x
        let dy = y
        if (ir > br) {
          dw = h * ir
          dx = x + (w - dw) * 0.5
        } else {
          dh = w / ir
          dy = y + (h - dh) * 0.5
        }
        ctx.drawImage(video, dx, dy, dw, dh)
      } else {
        ctx.drawImage(video, x, y, w, h)
      }
      ctx.restore()
      if (!video.paused && !video.ended) {
        if (onVideoPlaying) {
          onVideoPlaying(video)
        } else {
          onAssetReady()
        }
      }
    }
    ctx.restore()
    return
  }

  if (tag === 'CANVAS') {
    const cvs = el as HTMLCanvasElement
    if (cvs.width > 0 && cvs.height > 0) {
      ctx.save()
      if (hasRadius) {
        traceRoundedRect(ctx, x, y, w, h, radii)
        ctx.clip()
      }
      ctx.drawImage(cvs, x, y, w, h)
      ctx.restore()
    }
    ctx.restore()
    return
  }

  if (tag === 'SVG') {
    const clone = el.cloneNode(true) as SVGSVGElement
    if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    clone.setAttribute('width', String(Math.round(w)))
    clone.setAttribute('height', String(Math.round(h)))
    const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(clone))}`
    const img = loadAsset(svgUrl, onAssetReady)
    if (img) {
      ctx.drawImage(img, x, y, w, h)
    }
    ctx.restore()
    return
  }

  if (clipsChildren) {
    traceRoundedRect(ctx, x, y, w, h, radii)
    ctx.clip()
  }

  // Direct text nodes + stacking-ordered element children
  for (const child of el.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      renderTextNode(ctx, child as Text, cs, targetRect)
    }
  }
  for (const childEl of orderedChildElements(el)) {
    paintElementTree(ctx, childEl, targetRect, snapScale, onAssetReady, false, onVideoPlaying)
  }

  ctx.restore()
}

function isTargetActive(entry: SnapshotEntry): boolean {
  if (!entry.isVisible) return false
  if (typeof document !== 'undefined' && document.hidden) return false
  return true
}

function scheduleVideoFrame(entry: SnapshotEntry, video: HTMLVideoElement): void {
  if (!isTargetActive(entry)) {
    entry.deferredWhileHidden = true
    return
  }
  const rvfc = (video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number })
    .requestVideoFrameCallback
  if (typeof rvfc === 'function') {
    if (entry.videoCallbacks.has(video)) return
    entry.videoCallbacks.add(video)
    rvfc.call(video, () => {
      entry.videoCallbacks.delete(video)
      if (!snapshotRegistry.has(entry.target)) return
      if (!isTargetActive(entry)) {
        entry.deferredWhileHidden = true
        return
      }
      scheduleSnapshotRefresh(entry)
    })
  } else {
    scheduleSnapshotRefresh(entry)
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

  const rawDpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1
  const capScale = Math.min(rawDpr, MAX_SNAP_DIM / cssW, MAX_SNAP_DIM / cssH)
  const scale = Math.max(1, Math.min(rawDpr, capScale > 0 ? capScale : 1))
  const bufW = Math.max(2, Math.round(cssW * scale))
  const bufH = Math.max(2, Math.round(cssH * scale))

  if (entry.canvas.width !== bufW) entry.canvas.width = bufW
  if (entry.canvas.height !== bufH) entry.canvas.height = bufH

  const ctx = entry.ctx
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, bufW, bufH)
  ctx.setTransform(scale, 0, 0, scale, 0, 0)

  const schedule = () => scheduleSnapshotRefresh(entry)
  const onVideoPlaying = (video: HTMLVideoElement) => scheduleVideoFrame(entry, video)
  paintElementTree(ctx, entry.target, rect, scale, schedule, true, onVideoPlaying)

  entry.version += 1
  const snapVersion = entry.version
  let cachedData: Uint8ClampedArray | null = null
  let dataFailed = false

  entry.snapshot = {
    canvas: entry.canvas,
    version: snapVersion,
    width: bufW,
    height: bufH,
    scale,
    cssWidth: cssW,
    cssHeight: cssH,
    get data(): Uint8ClampedArray {
      if (cachedData) return cachedData
      if (dataFailed) return new Uint8ClampedArray(0)
      try {
        cachedData = ctx.getImageData(0, 0, bufW, bufH).data
        return cachedData
      } catch {
        dataFailed = true
        return new Uint8ClampedArray(0)
      }
    },
  }

  for (const notify of entry.consumers) notify()
}

function scheduleSnapshotRefresh(entry: SnapshotEntry): void {
  if (!isTargetActive(entry)) {
    entry.deferredWhileHidden = true
    return
  }
  if (entry.rafId) return
  entry.rafId = requestAnimationFrame(() => captureSnapshotNow(entry))
}

export function getTargetSnapshot(target: HTMLElement): TargetSnapshot | null {
  return snapshotRegistry.get(target)?.snapshot ?? null
}

/**
 * Registers a consumer for a shared offscreen DOM backdrop snapshot of `target`.
 * Multiple `<LiquidGlass />` components targeting the same scene share one snapshot buffer.
 */
export function subscribeTargetSnapshot(target: HTMLElement, onUpdate: () => void): () => void {
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
      videoCallbacks: new WeakSet(),
      consumers: new Set(),
      rafId: 0,
      fontsHooked: false,
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
          if (el && !el.closest('[data-lg-root], [data-lg-ignore]')) {
            scheduleSnapshotRefresh(created)
            break
          }
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
        { rootMargin: '200px' },
      )
      created.io.observe(target)
    }

    created.ro.observe(target)
    created.mo.observe(target, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    })
    target.addEventListener('loadeddata', created.onMedia, true)
    target.addEventListener('play', created.onMedia, true)
    target.addEventListener('seeked', created.onMedia, true)
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', created.onVisibilityChange)
    }

    if (typeof document !== 'undefined' && document.fonts?.ready) {
      created.fontsHooked = true
      void document.fonts.ready.then(() => {
        if (snapshotRegistry.has(target)) scheduleSnapshotRefresh(created)
      })
    }

    snapshotRegistry.set(target, created)
    captureSnapshotNow(created)
    entry = created
    notifySnapshotStats()
  }

  entry.consumers.add(onUpdate)
  if (!entry.snapshot) captureSnapshotNow(entry)

  return () => {
    const cur = snapshotRegistry.get(target)
    if (!cur) return
    cur.consumers.delete(onUpdate)
    if (cur.consumers.size === 0) {
      if (cur.rafId) cancelAnimationFrame(cur.rafId)
      cur.ro.disconnect()
      cur.mo.disconnect()
      cur.io?.disconnect()
      target.removeEventListener('loadeddata', cur.onMedia, true)
      target.removeEventListener('play', cur.onMedia, true)
      target.removeEventListener('seeked', cur.onMedia, true)
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', cur.onVisibilityChange)
      }
      snapshotRegistry.delete(target)
      notifySnapshotStats()
    }
  }
}
