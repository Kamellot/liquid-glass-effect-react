import { paintScene } from './scenePaint'

const MAX_TEXTURE_SIDE = 4096
const MAX_TEXTURE_PIXELS = 4_500_000

/**
 * A refractable region. Owns the offscreen "scene mirror" canvas that the WebGL
 * engine uploads as a texture, and keeps it fresh: it re-captures (debounced) when
 * the subtree resizes or mutates, when fonts / images finish loading, and on window
 * load. The capture only happens on those events — never per frame.
 */
export class SceneHandle {
  el: HTMLElement | null = null
  readonly canvas = document.createElement('canvas')
  /** Bumped after every successful capture; the engine re-uploads when it changes. */
  version = 0
  cssWidth = 0
  cssHeight = 0

  private listeners = new Set<() => void>()
  private timer = 0
  private ro: ResizeObserver | null = null
  private mo: MutationObserver | null = null
  private onLoad = () => this.invalidate(0)
  private onAsset = () => this.invalidate(30)

  attach(el: HTMLElement) {
    this.el = el
    this.ro = new ResizeObserver(() => this.invalidate(120))
    this.ro.observe(el)
    this.mo = new MutationObserver((records) => {
      // Ignore churn that originates inside glass layers / the dragged lens.
      const relevant = records.some((r) => {
        const target = r.target instanceof Element ? r.target : r.target.parentElement
        return !target?.closest('[data-glass-ignore], .lg-layer')
      })
      if (relevant) this.invalidate(120)
    })
    this.mo.observe(el, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'src', 'hidden'] })
    window.addEventListener('load', this.onLoad)
    document.fonts?.ready.then(this.onLoad)
    this.invalidate(0)
  }

  detach() {
    this.ro?.disconnect()
    this.mo?.disconnect()
    window.removeEventListener('load', this.onLoad)
    window.clearTimeout(this.timer)
    this.timer = 0
    this.el = null
  }

  onCapture(cb: () => void) {
    this.listeners.add(cb)
    return () => void this.listeners.delete(cb)
  }

  invalidate(delay = 100) {
    if (this.timer) return
    this.timer = window.setTimeout(() => {
      this.timer = 0
      this.capture()
    }, delay)
  }

  capture() {
    const el = this.el
    if (!el) return
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return
    const scale = Math.min(
      Math.min(2, window.devicePixelRatio || 1),
      MAX_TEXTURE_SIDE / Math.max(r.width, r.height),
      Math.sqrt(MAX_TEXTURE_PIXELS / (r.width * r.height)),
    )
    try {
      const { cssWidth, cssHeight } = paintScene(el, this.canvas, scale, this.onAsset)
      this.cssWidth = cssWidth
      this.cssHeight = cssHeight
      this.version++
      this.listeners.forEach((l) => l())
    } catch (e) {
      console.error('[liquid-glass] scene capture failed', e)
    }
  }
}

