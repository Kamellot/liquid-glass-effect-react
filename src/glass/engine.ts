import type { GlassEngine } from './types'
import { isWebGLAvailable } from './webglEngine'

/**
 * Engine selection.
 *
 *  svg      – `backdrop-filter: url(#filter)`: live DOM refraction (Chromium, Firefox).
 *  webgl    – shared WebGL shader refracting a mirrored <GlassScene> texture. Works on
 *             every WebKit build (Safari + all iOS browsers), which drop `url()` from
 *             `-webkit-backdrop-filter`.
 *  fallback – masked bevel-ring backdrop blur; used when WebGL is unavailable or the
 *             glass is not inside a <GlassScene>.
 */
export type ResolvedEngine = 'svg' | 'webgl' | 'fallback'

function detectWebKit(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  const iOS =
    /iP(hone|ad|od)/.test(ua) ||
    // iPadOS reports itself as a Mac
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  if (iOS) return true
  return /safari/i.test(ua) && !/chrome|chromium|crios|android|edg|opr|fxios/i.test(ua)
}

function acceptsBackdropUrl(): boolean {
  if (typeof document === 'undefined') return false
  const el = document.createElement('div')
  el.style.setProperty('backdrop-filter', 'url(#lg-probe)')
  if (el.style.getPropertyValue('backdrop-filter').includes('url(')) return true
  el.style.setProperty('-webkit-backdrop-filter', 'url(#lg-probe)')
  return el.style.getPropertyValue('-webkit-backdrop-filter').includes('url(')
}

let autoPick: 'svg' | 'webgl' | null = null

function auto(): 'svg' | 'webgl' {
  if (autoPick) return autoPick
  const q = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('engine') : null
  if (q === 'svg' || q === 'webgl') return (autoPick = q)
  return (autoPick = detectWebKit() || !acceptsBackdropUrl() ? 'webgl' : 'svg')
}

export function resolveEngine(pref: GlassEngine | undefined, hasScene: boolean): ResolvedEngine {
  let want: GlassEngine = pref ?? 'auto'
  if (want === 'auto') {
    const q = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('engine') : null
    want = q === 'fallback' ? 'fallback' : auto()
  }
  if (want === 'webgl' && !(hasScene && isWebGLAvailable())) return 'fallback'
  return want
}

/** What `auto` resolves to for a glass that lives inside a <GlassScene>. */
export const detectEngine = (): ResolvedEngine => resolveEngine('auto', true)
