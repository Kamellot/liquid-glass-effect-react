import { generateDisplacementMap, type MapGeometry } from './displacementMap'
import { CHROMA_SPREAD, STRENGTH_GAIN } from './optics'
import type { OpticalParams } from './types'

/**
 * Global, ref-counted <filter> registry.
 *
 * All <LiquidGlass /> instances whose geometry + optical parameters hash to the same
 * key share exactly ONE <filter> node inside ONE hidden <svg><defs>. Filters are
 * garbage-collected shortly after their last consumer releases them (the grace
 * period avoids thrash while a slider is being dragged).
 */

const SVG_NS = 'http://www.w3.org/2000/svg'
const XLINK_NS = 'http://www.w3.org/1999/xlink'
const GC_DELAY = 1200


export interface FilterSpec extends MapGeometry, Pick<OpticalParams, 'depth' | 'curvature' | 'splay' | 'strength' | 'chroma' | 'blur'> {}

interface Entry {
  id: string
  node: SVGFilterElement
  refs: number
  timer: number | null
}

const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()
let defs: SVGDefsElement | null = null

/** `width_height_radius_depth_curvature_splay_strength_chroma_blur` */
export function hashSpec(s: FilterSpec): string {
  return [
    s.width,
    s.height,
    Math.round(s.radius),
    s.depth.toFixed(1),
    s.curvature.toFixed(2),
    s.splay.toFixed(2),
    s.strength.toFixed(3),
    s.chroma.toFixed(2),
    s.blur.toFixed(1),
  ].join('_')
}

export const filterIdFor = (s: FilterSpec) => 'lg-' + hashSpec(s).replace(/\./g, 'p')

function ensureDefs(): SVGDefsElement {
  if (defs && defs.isConnected) return defs
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  svg.setAttribute('width', '0')
  svg.setAttribute('height', '0')
  svg.setAttribute('data-liquid-glass-filters', '')
  // Not display:none — that disables filter resolution in several engines.
  svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none'
  defs = document.createElementNS(SVG_NS, 'defs')
  svg.appendChild(defs)
  document.body.appendChild(svg)
  return defs
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) {
  const e = document.createElementNS(SVG_NS, tag)
  for (const k in attrs) e.setAttribute(k, String(attrs[k]))
  return e
}

const channelMatrix = (ch: 'r' | 'g' | 'b') => {
  const row = (on: boolean) => (on ? '1 0 0 0 0' : '0 0 0 0 0')
  const rows = {
    r: [row(true), '0 0 0 0 0', '0 0 0 0 0'],
    g: ['0 0 0 0 0', '0 1 0 0 0', '0 0 0 0 0'],
    b: ['0 0 0 0 0', '0 0 0 0 0', '0 0 1 0 0'],
  }[ch]
  return [...rows, '0 0 0 1 0'].join(' ')
}

function buildFilter(id: string, s: FilterSpec): SVGFilterElement {
  const map = generateDisplacementMap(s, s)
  const filter = el('filter', {
    id,
    filterUnits: 'userSpaceOnUse',
    primitiveUnits: 'userSpaceOnUse',
    x: 0,
    y: 0,
    width: s.width,
    height: s.height,
    'color-interpolation-filters': 'sRGB',
  })

  const feImage = el('feImage', {
    x: 0,
    y: 0,
    width: s.width,
    height: s.height,
    preserveAspectRatio: 'none',
    result: 'map',
  })
  feImage.setAttribute('href', map.url)
  feImage.setAttributeNS(XLINK_NS, 'xlink:href', map.url)
  filter.appendChild(feImage)

  // feDisplacementMap offset = scale·(C − ½) ⇒ scale = 2 × peak pixels.
  const peak = s.strength * Math.min(s.width, s.height) * STRENGTH_GAIN
  const scale = peak * 2

  const displace = (scaleMul: number, result: string) =>
    el('feDisplacementMap', {
      in: 'SourceGraphic',
      in2: 'map',
      scale: (scale * scaleMul).toFixed(3),
      xChannelSelector: 'R',
      yChannelSelector: 'G',
      result,
    })

  if (s.chroma <= 0) {
    // Fast path: one displacement pass, no colour split / blend.
    filter.appendChild(displace(1, 'out'))
    return filter
  }

  const spread = CHROMA_SPREAD * s.chroma
  filter.appendChild(displace(1 + spread, 'dR'))
  filter.appendChild(displace(1, 'dG'))
  filter.appendChild(displace(1 - spread, 'dB'))
  for (const [ch, src] of [['r', 'dR'], ['g', 'dG'], ['b', 'dB']] as const) {
    filter.appendChild(el('feColorMatrix', { in: src, type: 'matrix', values: channelMatrix(ch), result: ch }))
  }
  filter.appendChild(el('feBlend', { in: 'r', in2: 'g', mode: 'screen', result: 'rg' }))
  filter.appendChild(el('feBlend', { in: 'rg', in2: 'b', mode: 'screen', result: 'out' }))
  return filter
}

const emit = () => listeners.forEach((l) => l())

export function acquireFilter(spec: FilterSpec): { id: string; release: () => void } {
  const key = hashSpec(spec)
  let entry = entries.get(key)
  if (!entry) {
    const id = filterIdFor(spec)
    const node = buildFilter(id, spec)
    ensureDefs().appendChild(node)
    entry = { id, node, refs: 0, timer: null }
    entries.set(key, entry)
    emit()
  }
  if (entry.timer !== null) {
    clearTimeout(entry.timer)
    entry.timer = null
  }
  entry.refs++
  const e = entry
  let released = false
  return {
    id: e.id,
    release() {
      if (released) return
      released = true
      if (--e.refs > 0) return
      e.timer = window.setTimeout(() => {
        if (e.refs > 0) return
        e.node.remove()
        entries.delete(key)
        emit()
      }, GC_DELAY)
    },
  }
}

/** Dev / demo introspection: live filter count and consumer count. */
export function getFilterStats() {
  let consumers = 0
  entries.forEach((e) => (consumers += e.refs))
  return { filters: entries.size, consumers }
}

export function subscribeFilterStats(cb: () => void) {
  listeners.add(cb)
  return () => void listeners.delete(cb)
}
