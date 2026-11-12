/**
 * "Scene mirror" painter — a deliberately small DOM → canvas rasteriser.
 *
 * It does NOT serialise the DOM (SVG foreignObject is unreliable on iOS) and does not
 * use html2canvas. It walks the subtree once, reads computed styles + layout rects
 * and replays them with plain Canvas 2D calls:
 *
 *   • background-color, linear-gradient(), url() images, size / position / repeat
 *   • uniform borders, per-corner border-radius, overflow clipping, opacity
 *   • text — drawn per character at the exact rect the browser laid it out at, so
 *     kerning, letter-spacing and line wrapping match the DOM
 *   • <img> and <canvas> elements
 *
 * Not supported (skipped): inline SVG, box/text shadows, filters, blend modes,
 * transforms other than translation/scale (they still land right via their rects).
 * Subtrees marked `data-glass-ignore`, glass layers and `.lg-content` are skipped:
 * they sit *above* the glass, so they must not appear in what it refracts.
 */

interface Env {
  ctx: CanvasRenderingContext2D
  ox: number
  oy: number
  onAsset: () => void
}
interface Box {
  x: number
  y: number
  w: number
  h: number
}
type Radii = [number, number, number, number]

const XHTML = 'http://www.w3.org/1999/xhtml'
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'LINK', 'META', 'TEMPLATE', 'HEAD'])
const MAX_TILES = 4000

/* ── image cache ─────────────────────────────────────────────────────────────── */

const images = new Map<string, HTMLImageElement | 'loading' | 'error'>()
const waiting = new Map<string, Set<() => void>>()

function getImage(url: string, onAsset: () => void): HTMLImageElement | null {
  const hit = images.get(url)
  if (hit && hit !== 'loading' && hit !== 'error') return hit
  if (hit === 'error') return null
  let set = waiting.get(url)
  if (!set) waiting.set(url, (set = new Set()))
  set.add(onAsset)
  if (!hit) {
    images.set(url, 'loading')
    const img = new Image()
    try {
      if (new URL(url, location.href).origin !== location.origin) img.crossOrigin = 'anonymous'
    } catch {
      /* ignore */
    }
    img.onload = () => {
      images.set(url, img)
      waiting.get(url)?.forEach((cb) => cb())
      waiting.delete(url)
    }
    img.onerror = () => {
      images.set(url, 'error')
      waiting.delete(url)
    }
    img.src = url
  }
  return null
}

/* ── small CSS value helpers ─────────────────────────────────────────────────── */

/** Split on a separator that is not nested inside parentheses. */
function splitTop(s: string, sep = ','): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === sep && depth === 0) {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

const px = (v: string) => parseFloat(v) || 0

function getRadii(cs: CSSStyleDeclaration, b: Box): Radii {
  const one = (v: string, ref: number) => {
    const tok = v.trim().split(/\s+/)[0] ?? '0'
    const n = parseFloat(tok) || 0
    return tok.endsWith('%') ? (n / 100) * ref : n
  }
  let r: Radii = [
    one(cs.borderTopLeftRadius, b.w),
    one(cs.borderTopRightRadius, b.w),
    one(cs.borderBottomRightRadius, b.w),
    one(cs.borderBottomLeftRadius, b.w),
  ]
  const f = Math.min(
    1,
    r[0] + r[1] > 0 ? b.w / (r[0] + r[1]) : 1,
    r[3] + r[2] > 0 ? b.w / (r[3] + r[2]) : 1,
    r[0] + r[3] > 0 ? b.h / (r[0] + r[3]) : 1,
    r[1] + r[2] > 0 ? b.h / (r[1] + r[2]) : 1,
  )
  if (f < 1) r = r.map((v) => v * f) as Radii
  return r
}

function roundRectPath(ctx: CanvasRenderingContext2D, b: Box, r: Radii) {
  const { x, y, w, h } = b
  ctx.beginPath()
  ctx.moveTo(x + r[0], y)
  ctx.lineTo(x + w - r[1], y)
  if (r[1]) ctx.arcTo(x + w, y, x + w, y + r[1], r[1])
  ctx.lineTo(x + w, y + h - r[2])
  if (r[2]) ctx.arcTo(x + w, y + h, x + w - r[2], y + h, r[2])
  ctx.lineTo(x + r[3], y + h)
  if (r[3]) ctx.arcTo(x, y + h, x, y + h - r[3], r[3])
  ctx.lineTo(x, y + r[0])
  if (r[0]) ctx.arcTo(x, y, x + r[0], y, r[0])
  ctx.closePath()
}

/* ── gradients ───────────────────────────────────────────────────────────────── */

/** Returns the unit direction vector (screen space, y down) of a CSS linear-gradient. */
function gradientDir(first: string, w: number, h: number): [number, number] | null {
  const m = first.match(/^(-?[\d.]+)(deg|grad|rad|turn)$/)
  if (m) {
    const v = parseFloat(m[1])
    const deg = m[2] === 'deg' ? v : m[2] === 'turn' ? v * 360 : m[2] === 'rad' ? (v * 180) / Math.PI : v * 0.9
    const a = (deg * Math.PI) / 180
    return [Math.sin(a), -Math.cos(a)]
  }
  if (first.startsWith('to ')) {
    const words = first.slice(3).split(/\s+/)
    const sx = words.includes('right') ? 1 : words.includes('left') ? -1 : 0
    const sy = words.includes('bottom') ? 1 : words.includes('top') ? -1 : 0
    if (sx && sy) {
      // "magic corners": the 50 % line passes through the two other corners.
      const dx = h * sx
      const dy = w * sy
      const len = Math.hypot(dx, dy) || 1
      return [dx / len, dy / len]
    }
    return [sx, sy]
  }
  return null
}

function makeGradient(ctx: CanvasRenderingContext2D, css: string, r: Box): CanvasGradient | null {
  const inner = css.slice(css.indexOf('(') + 1, css.lastIndexOf(')'))
  const args = splitTop(inner)
  if (!args.length) return null
  let dir: [number, number] = [0, 1] // default: to bottom
  let stopsArgs = args
  const d = gradientDir(args[0], r.w, r.h)
  if (d) {
    dir = d
    stopsArgs = args.slice(1)
  }
  const L = Math.abs(r.w * dir[0]) + Math.abs(r.h * dir[1])
  const cx = r.x + r.w / 2
  const cy = r.y + r.h / 2
  const g = ctx.createLinearGradient(cx - (dir[0] * L) / 2, cy - (dir[1] * L) / 2, cx + (dir[0] * L) / 2, cy + (dir[1] * L) / 2)

  const stops: { color: string; pos: number | null }[] = []
  for (const arg of stopsArgs) {
    const toks = splitTop(arg, ' ')
    const posToks: number[] = []
    while (toks.length > 1 && /^-?[\d.]+(%|px)$/.test(toks[toks.length - 1])) {
      const t = toks.pop() as string
      const v = parseFloat(t)
      posToks.unshift(t.endsWith('%') ? v / 100 : L ? v / L : 0)
    }
    if (!toks.length || (toks.length === 1 && /^-?[\d.]+(%|px)$/.test(toks[0]))) continue // colour hint
    const color = toks.join(' ')
    if (!posToks.length) stops.push({ color, pos: null })
    else posToks.forEach((p) => stops.push({ color, pos: p }))
  }
  if (stops.length < 2) return null
  if (stops[0].pos === null) stops[0].pos = 0
  if (stops[stops.length - 1].pos === null) stops[stops.length - 1].pos = 1
  for (let i = 0; i < stops.length; i++) {
    if (stops[i].pos !== null) continue
    let j = i
    while (stops[j].pos === null) j++
    const a = stops[i - 1].pos as number
    const b = stops[j].pos as number
    for (let k = i; k < j; k++) stops[k].pos = a + ((b - a) * (k - i + 1)) / (j - i + 1)
  }
  let last = 0
  try {
    for (const s of stops) {
      last = Math.min(1, Math.max(last, s.pos as number))
      g.addColorStop(last, s.color)
    }
  } catch {
    return null
  }
  return g
}

/* ── backgrounds / borders ───────────────────────────────────────────────────── */

function parsePos(token: string, free: number): number {
  switch (token) {
    case 'left':
    case 'top':
      return 0
    case 'center':
      return free / 2
    case 'right':
    case 'bottom':
      return free
  }
  const v = parseFloat(token) || 0
  return token.endsWith('%') ? (free * v) / 100 : v
}

function drawBackgrounds(cs: CSSStyleDeclaration, b: Box, radii: Radii, env: Env) {
  const { ctx } = env
  const hasRadius = radii.some((r) => r > 0)

  if (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') {
    ctx.fillStyle = cs.backgroundColor
    if (hasRadius) {
      roundRectPath(ctx, b, radii)
      ctx.fill()
    } else ctx.fillRect(b.x, b.y, b.w, b.h)
  }

  if (!cs.backgroundImage || cs.backgroundImage === 'none') return
  const layers = splitTop(cs.backgroundImage)
  const sizes = splitTop(cs.backgroundSize || 'auto')
  const poss = splitTop(cs.backgroundPosition || '0% 0%')
  const reps = splitTop(cs.backgroundRepeat || 'repeat')

  ctx.save()
  if (hasRadius) {
    roundRectPath(ctx, b, radii)
    ctx.clip()
  } else {
    ctx.beginPath()
    ctx.rect(b.x, b.y, b.w, b.h)
    ctx.clip()
  }

  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i]
    const size = (sizes[i % sizes.length] ?? 'auto').split(/\s+/)
    const pos = (poss[i % poss.length] ?? '0% 0%').split(/\s+/)
    const rep = reps[i % reps.length] ?? 'repeat'

    let img: HTMLImageElement | null = null
    let nw = 0
    let nh = 0
    const isGradient = layer.startsWith('linear-gradient(')
    if (layer.startsWith('url(')) {
      const url = layer.slice(4, layer.lastIndexOf(')')).trim().replace(/^["']|["']$/g, '')
      img = getImage(new URL(url, location.href).href, env.onAsset)
      if (!img) continue
      nw = img.naturalWidth
      nh = img.naturalHeight
    } else if (!isGradient) continue

    // background-size
    let tw: number
    let th: number
    if (size[0] === 'cover' || size[0] === 'contain') {
      const k = size[0] === 'cover' ? Math.max(b.w / nw, b.h / nh) : Math.min(b.w / nw, b.h / nh)
      tw = nw * k
      th = nh * k
    } else {
      const len = (t: string | undefined, ref: number) => (!t || t === 'auto' ? null : t.endsWith('%') ? (parseFloat(t) / 100) * ref : px(t))
      const wTok = len(size[0], b.w)
      const hTok = len(size[1] ?? 'auto', b.h)
      if (img) {
        tw = wTok ?? (hTok != null ? (hTok * nw) / nh : nw)
        th = hTok ?? (wTok != null ? (wTok * nh) / nw : nh)
      } else {
        tw = wTok ?? b.w
        th = hTok ?? b.h
      }
    }
    if (tw < 0.5 || th < 0.5) continue

    const rx = rep === 'repeat' || rep === 'repeat-x' || rep.startsWith('repeat ') || rep === 'round' || rep === 'space'
    const ry = rep === 'repeat' || rep === 'repeat-y' || rep.endsWith(' repeat') || rep === 'round' || rep === 'space'
    let x0 = parsePos(pos[0] ?? '0%', b.w - tw)
    let y0 = parsePos(pos[1] ?? pos[0] ?? '0%', b.h - th)
    if (rx) {
      x0 %= tw
      if (x0 > 0) x0 -= tw
    }
    if (ry) {
      y0 %= th
      if (y0 > 0) y0 -= th
    }

    let tiles = 0
    for (let y = y0; y < b.h && tiles < MAX_TILES; y += th) {
      for (let x = x0; x < b.w && tiles < MAX_TILES; x += tw) {
        tiles++
        const tile: Box = { x: b.x + x, y: b.y + y, w: tw, h: th }
        if (img) ctx.drawImage(img, tile.x, tile.y, tw, th)
        else {
          const g = makeGradient(ctx, layer, tile)
          if (g) {
            ctx.fillStyle = g
            ctx.fillRect(tile.x, tile.y, tw, th)
          }
        }
        if (!rx) break
      }
      if (!ry) break
    }
  }
  ctx.restore()
}

function drawBorder(cs: CSSStyleDeclaration, b: Box, radii: Radii, ctx: CanvasRenderingContext2D) {
  const w = [px(cs.borderTopWidth), px(cs.borderRightWidth), px(cs.borderBottomWidth), px(cs.borderLeftWidth)]
  const style = [cs.borderTopStyle, cs.borderRightStyle, cs.borderBottomStyle, cs.borderLeftStyle]
  const col = [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor]
  const on = w.map((v, i) => v > 0 && style[i] !== 'none' && style[i] !== 'hidden')
  if (!on.some(Boolean)) return
  const uniform = w.every((v) => v === w[0]) && col.every((c) => c === col[0]) && on.every(Boolean)
  if (uniform) {
    const half = w[0] / 2
    ctx.strokeStyle = col[0]
    ctx.lineWidth = w[0]
    roundRectPath(ctx, { x: b.x + half, y: b.y + half, w: b.w - w[0], h: b.h - w[0] }, radii.map((r) => Math.max(0, r - half)) as Radii)
    ctx.stroke()
    return
  }
  const rects: Box[] = [
    { x: b.x, y: b.y, w: b.w, h: w[0] },
    { x: b.x + b.w - w[1], y: b.y, w: w[1], h: b.h },
    { x: b.x, y: b.y + b.h - w[2], w: b.w, h: w[2] },
    { x: b.x, y: b.y, w: w[3], h: b.h },
  ]
  rects.forEach((r, i) => {
    if (!on[i]) return
    ctx.fillStyle = col[i]
    ctx.fillRect(r.x, r.y, r.w, r.h)
  })
}

/* ── text ────────────────────────────────────────────────────────────────────── */

const metricsCache = new Map<string, { asc: number; desc: number }>()

function paintText(node: Text, cs: CSSStyleDeclaration, env: Env, alpha: number) {
  const text = node.data
  if (!text.trim()) return
  const { ctx } = env
  const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
  ctx.font = font
  ctx.fillStyle = cs.color
  ctx.globalAlpha = alpha
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'

  let m = metricsCache.get(font)
  if (!m) {
    const tm = ctx.measureText('Mg')
    const size = parseFloat(cs.fontSize) || 16
    m = { asc: tm.fontBoundingBoxAscent ?? size * 0.8, desc: tm.fontBoundingBoxDescent ?? size * 0.2 }
    metricsCache.set(font, m)
  }

  const upper = cs.textTransform === 'uppercase'
  const lower = cs.textTransform === 'lowercase'
  const range = document.createRange()
  let i = 0
  for (const ch of text) {
    const len = ch.length
    if (!/\s/.test(ch)) {
      range.setStart(node, i)
      range.setEnd(node, i + len)
      const r = range.getClientRects()[0]
      if (r && r.width > 0) {
        const baseline = r.top - env.oy + (r.height - (m.asc + m.desc)) / 2 + m.asc
        ctx.fillText(upper ? ch.toUpperCase() : lower ? ch.toLowerCase() : ch, r.left - env.ox, baseline)
      }
    }
    i += len
  }
}

/* ── tree walk ───────────────────────────────────────────────────────────────── */

function shouldSkip(el: Element): boolean {
  if (el.namespaceURI !== XHTML) return true // inline SVG etc.
  if (SKIP_TAGS.has(el.tagName)) return true
  if (el.hasAttribute('data-glass-ignore')) return true
  const c = el.classList
  return c.contains('lg-layer') || c.contains('lg-content')
}

/** Approximate CSS paint order: negative z → in-flow → positioned → positive z. */
function paintKey(cs: CSSStyleDeclaration): number {
  const z = cs.zIndex
  if (z !== 'auto') {
    const n = parseInt(z, 10) || 0
    return n < 0 ? n : n + 0.5
  }
  return cs.position !== 'static' ? 0.5 : 0
}

function paintElement(el: Element, env: Env, parentAlpha: number) {
  if (shouldSkip(el)) return
  const cs = getComputedStyle(el)
  if (cs.display === 'none' || cs.visibility === 'hidden') return
  const alpha = parentAlpha * (parseFloat(cs.opacity) || 0)
  if (alpha <= 0.001) return

  const rect = el.getBoundingClientRect()
  const b: Box = { x: rect.left - env.ox, y: rect.top - env.oy, w: rect.width, h: rect.height }
  const { ctx } = env
  ctx.save()
  ctx.globalAlpha = alpha

  if (b.w > 0 && b.h > 0) {
    const radii = getRadii(cs, b)
    drawBackgrounds(cs, b, radii, env)
    ctx.globalAlpha = alpha

    if (el instanceof HTMLImageElement && el.complete && el.naturalWidth) {
      const fit = cs.objectFit
      let dw = b.w
      let dh = b.h
      if (fit === 'cover' || fit === 'contain') {
        const k = (fit === 'cover' ? Math.max : Math.min)(b.w / el.naturalWidth, b.h / el.naturalHeight)
        dw = el.naturalWidth * k
        dh = el.naturalHeight * k
      }
      ctx.save()
      roundRectPath(ctx, b, radii)
      ctx.clip()
      ctx.drawImage(el, b.x + (b.w - dw) / 2, b.y + (b.h - dh) / 2, dw, dh)
      ctx.restore()
    } else if (el instanceof HTMLCanvasElement && el.width && el.height) {
      ctx.drawImage(el, b.x, b.y, b.w, b.h)
    }

    drawBorder(cs, b, radii, ctx)

    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
      roundRectPath(ctx, b, radii)
      ctx.clip()
    }
  }

  const items: { node: Node; key: number; order: number }[] = []
  let order = 0
  el.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) items.push({ node, key: 0, order: order++ })
    else if (node.nodeType === Node.ELEMENT_NODE) {
      const child = node as Element
      if (shouldSkip(child)) return
      items.push({ node, key: paintKey(getComputedStyle(child)), order: order++ })
    }
  })
  items.sort((a, b2) => a.key - b2.key || a.order - b2.order)
  for (const it of items) {
    if (it.node.nodeType === Node.TEXT_NODE) paintText(it.node as Text, cs, env, alpha)
    else paintElement(it.node as Element, env, alpha)
  }
  ctx.restore()
}

/** Paint `root` (and descendants) into `canvas`. Returns the captured CSS size. */
export function paintScene(root: HTMLElement, canvas: HTMLCanvasElement, scale: number, onAsset: () => void) {
  const rr = root.getBoundingClientRect()
  canvas.width = Math.max(1, Math.round(rr.width * scale))
  canvas.height = Math.max(1, Math.round(rr.height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D canvas unavailable')
  ctx.setTransform(canvas.width / rr.width, 0, 0, canvas.height / rr.height, 0, 0)
  // Opaque base = the page background + subtle 48px grid so transparent regions match the page.
  ctx.fillStyle = getComputedStyle(document.body).backgroundColor || '#0a0b0e'
  ctx.fillRect(0, 0, rr.width, rr.height)
  const step = 48
  const gx0 = ((-rr.left % step) + step) % step
  const gy0 = ((-rr.top % step) + step) % step
  ctx.fillStyle = 'rgba(255, 255, 255, 0.035)'
  for (let x = gx0; x < rr.width; x += step) ctx.fillRect(x, 0, 1, rr.height)
  for (let y = gy0; y < rr.height; y += step) ctx.fillRect(0, y, rr.width, 1)

  paintElement(root, { ctx, ox: rr.left, oy: rr.top, onAsset }, 1)
  return { cssWidth: rr.width, cssHeight: rr.height }
}

