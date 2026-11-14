import type { RefObject } from 'react'

export interface BoxMetrics {
  width: number
  height: number
  borderRadius: number
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1)
}

export function degToRad(degrees: number): number {
  return (degrees * Math.PI) / 180
}

export function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

function parseColorChannel(raw: string, scale255: boolean): number {
  const trimmed = raw.trim()
  const val = parseFloat(trimmed)
  if (!Number.isFinite(val)) return Number.NaN
  if (trimmed.endsWith('%')) return clamp01(val / 100)
  return clamp01(scale255 ? val / 255 : val)
}

/** Parses CSS `rgb(...)` / `rgba(...)` into normalized `[r, g, b, a]` in `[0, 1]`, or `null` if unparsed. */
export function parseCssColorRgba(color: string): [number, number, number, number] | null {
  if (!color) return null
  const trimmed = color.trim()
  if (trimmed.toLowerCase() === 'transparent') return [0, 0, 0, 0]

  const match = /^rgba?\(([^)]+)\)$/i.exec(trimmed)
  if (!match) return null

  const body = match[1].trim()
  let rgbParts: string[]
  let alphaStr: string | undefined

  if (body.includes('/')) {
    const [left, right] = body.split('/')
    rgbParts = left.trim().split(/[\s,]+/)
    alphaStr = right.trim()
  } else {
    rgbParts = body.split(/[\s,]+/)
    alphaStr = rgbParts[3]
  }

  if (rgbParts.length < 3) return null
  const r = parseColorChannel(rgbParts[0], true)
  const g = parseColorChannel(rgbParts[1], true)
  const b = parseColorChannel(rgbParts[2], true)
  const a = alphaStr !== undefined ? parseColorChannel(alphaStr, false) : 1

  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b) || !Number.isFinite(a)) {
    return null
  }
  return [r, g, b, a]
}

export function isTransparentColor(color: string): boolean {
  if (!color || color === 'transparent') return true
  const parsed = parseCssColorRgba(color)
  return parsed !== null && parsed[3] <= 0.001
}

export function parseLengthPx(raw: string, refSize: number): number {
  const token = raw.trim().split(/\s+/)[0]
  if (!token) return 0
  const val = parseFloat(token)
  if (!Number.isFinite(val)) return 0
  return token.endsWith('%') ? (val / 100) * refSize : val
}

export function parseCornerRadii(
  cs: CSSStyleDeclaration,
  width: number,
  height: number,
  percentRef = width,
): [number, number, number, number] {
  const maxR = Math.min(width, height) * 0.5
  return [
    clamp(parseLengthPx(cs.borderTopLeftRadius, percentRef), 0, maxR),
    clamp(parseLengthPx(cs.borderTopRightRadius, percentRef), 0, maxR),
    clamp(parseLengthPx(cs.borderBottomRightRadius, percentRef), 0, maxR),
    clamp(parseLengthPx(cs.borderBottomLeftRadius, percentRef), 0, maxR),
  ]
}

export function measureElementBox(el: HTMLElement, explicitRadius?: number | string): BoxMetrics {
  const width = Math.max(0, Math.round(el.offsetWidth || el.getBoundingClientRect().width))
  const height = Math.max(0, Math.round(el.offsetHeight || el.getBoundingClientRect().height))
  if (width === 0 || height === 0) {
    return { width: 0, height: 0, borderRadius: 0 }
  }
  const minDim = Math.min(width, height)
  if (typeof explicitRadius === 'number' && Number.isFinite(explicitRadius)) {
    return { width, height, borderRadius: clamp(explicitRadius, 0, minDim * 0.5) }
  }
  const radii = parseCornerRadii(getComputedStyle(el), width, height, minDim)
  return { width, height, borderRadius: Math.max(...radii) }
}

export function resolveTarget(
  target: RefObject<HTMLElement | null> | HTMLElement | null | undefined,
): HTMLElement | null {
  if (!target) return null
  return 'current' in target ? target.current : target
}
