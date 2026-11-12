import type { GlassEngine } from './types'

/**
 * Engine / feature detection.
 *
 * Chromium and Firefox accept `backdrop-filter: url(#id)`. Every WebKit build
 * (desktop Safari and *all* iOS browsers, including Chrome/Firefox for iOS) drops
 * `url()` from `-webkit-backdrop-filter`, so they take the bevel-ring fallback.
 */

export type ResolvedEngine = 'svg' | 'fallback'

function detectWebKit(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  const iOS =
    /iP(hone|ad|od)/.test(ua) ||
    // iPadOS reports itself as a Mac
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  if (iOS) return true
  const safari = /safari/i.test(ua) && !/chrome|chromium|crios|android|edg|opr|fxios/i.test(ua)
  return safari
}

function acceptsBackdropUrl(): boolean {
  if (typeof document === 'undefined') return false
  const el = document.createElement('div')
  el.style.setProperty('backdrop-filter', 'url(#lg-probe)')
  if (el.style.getPropertyValue('backdrop-filter').includes('url(')) return true
  el.style.setProperty('-webkit-backdrop-filter', 'url(#lg-probe)')
  return el.style.getPropertyValue('-webkit-backdrop-filter').includes('url(')
}

let cached: ResolvedEngine | null = null

export function detectEngine(): ResolvedEngine {
  if (cached) return cached
  if (typeof window !== 'undefined') {
    const q = new URLSearchParams(window.location.search).get('engine')
    if (q === 'svg' || q === 'fallback') return (cached = q)
  }
  cached = detectWebKit() || !acceptsBackdropUrl() ? 'fallback' : 'svg'
  return cached
}

export function resolveEngine(pref: GlassEngine | undefined): ResolvedEngine {
  return pref === 'svg' || pref === 'fallback' ? pref : detectEngine()
}

