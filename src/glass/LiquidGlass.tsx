import { memo, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { bevelWidth } from './displacementMap'
import { resolveEngine } from './engine'
import { acquireFilter } from './filterRegistry'
import { DEFAULTS, type LiquidGlassProps } from './types'
import './LiquidGlass.css'

interface Metrics {
  w: number
  h: number
  r: number
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Parse the first corner radius of a computed `border-radius` into px. */
function parseRadius(raw: string, w: number, h: number): number {
  const tok = raw.trim().split(/[\s/]+/)[0] ?? '0'
  const v = parseFloat(tok) || 0
  const px = tok.endsWith('%') ? (v / 100) * Math.min(w, h) : v
  return clamp(px, 0, Math.min(w, h) / 2)
}

function useMetrics(
  ref: React.RefObject<HTMLDivElement | null>,
  size: number | undefined,
  borderRadius: LiquidGlassProps['borderRadius'],
): Metrics {
  const [m, setM] = useState<Metrics>({ w: 0, h: 0, r: 0 })

  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    let raf = 0

    const measure = () => {
      raf = 0
      // offsetWidth/Height ignore ancestor transforms (the lens is dragged with one).
      const w = size ?? node.offsetWidth
      const h = size ?? node.offsetHeight
      const raw = size != null ? `${size / 2}px` : getComputedStyle(node).borderTopLeftRadius
      const r = parseRadius(raw, w, h)
      setM((p) => (p.w === w && p.h === h && Math.abs(p.r - r) < 0.5 ? p : { w, h, r }))
    }
    measure()
    if (size != null) return
    const ro = new ResizeObserver(() => {
      if (!raf) raf = requestAnimationFrame(measure)
    })
    ro.observe(node)
    return () => {
      ro.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [ref, size, borderRadius])

  return m
}

function LiquidGlassImpl({
  size,
  strength = DEFAULTS.strength,
  curvature = DEFAULTS.curvature,
  depth = DEFAULTS.depth,
  splay = DEFAULTS.splay,
  chroma = DEFAULTS.chroma,
  blur = DEFAULTS.blur,
  edgeHighlight = DEFAULTS.edgeHighlight,
  glow = DEFAULTS.glow,
  specularAngle = DEFAULTS.specularAngle,
  mode = 'layer',
  borderRadius,
  engine: enginePref = 'auto',
  className,
  style,
  children,
}: LiquidGlassProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const { w, h, r } = useMetrics(hostRef, size, borderRadius)
  const engine = useMemo(() => resolveEngine(enginePref), [enginePref])

  // ---- Refraction filter (shared, ref-counted, deduplicated by hash) ----------
  const [filterId, setFilterId] = useState<string | null>(null)
  useLayoutEffect(() => {
    if (engine !== 'svg' || w < 2 || h < 2) {
      setFilterId(null)
      return
    }
    const handle = acquireFilter({ width: w, height: h, radius: r, depth, curvature, splay, strength, chroma, blur })
    setFilterId(handle.id)
    return handle.release
  }, [engine, w, h, r, depth, curvature, splay, strength, chroma, blur])

  // ---- Lighting vars (pure CSS custom properties → no layout, no filter rebuild) --
  const bevel = w && h ? bevelWidth(w, h, depth) : 8
  const rad = (specularAngle * Math.PI) / 180
  const shortSide = Math.min(w || 100, h || 100)
  const k = clamp(shortSide * 0.035, 2, 9) // glow offset in px
  const vars = {
    '--lg-bevel': `${bevel}px`,
    '--lg-blur': `${blur}px`,
    '--lg-edge': edgeHighlight,
    '--lg-glow': glow,
    '--lg-angle': `${specularAngle}deg`,
    // Light comes from the θ-edge ⇒ the inset shadow is pushed *away* from it.
    '--lg-dx': `${-Math.sin(rad) * k}px`,
    '--lg-dy': `${Math.cos(rad) * k}px`,
    '--lg-gb': `${k * 2.6}px`,
  } as CSSProperties

  const refractStyle: CSSProperties | undefined =
    engine === 'svg' && filterId
      ? (() => {
          const v = `url(#${filterId}) blur(${blur}px) saturate(1.12) brightness(1.04)`
          return { backdropFilter: v, WebkitBackdropFilter: v }
        })()
      : undefined

  const layer = (
    <div
      ref={mode === 'layer' ? hostRef : undefined}
      className={'lg-layer' + (mode === 'layer' && className ? ' ' + className : '')}
      data-lg-engine={engine}
      aria-hidden="true"
      style={{
        ...vars,
        ...(mode === 'layer' ? layerHostStyle(size, borderRadius, style) : null),
      }}
    >
      {engine === 'svg' ? (
        <div className="lg-refract" style={refractStyle} />
      ) : (
        <>
          <div className="lg-fb-base" />
          <div className="lg-fb-ring lg-fb-ring--outer" />
          <div className="lg-fb-ring lg-fb-ring--inner" />
        </>
      )}
    </div>
  )

  if (mode === 'layer') return layer

  return (
    <div
      ref={hostRef}
      className={'lg-wrapper' + (className ? ' ' + className : '')}
      style={{
        ...(size != null ? { width: size, height: size, borderRadius: size / 2 } : null),
        ...(borderRadius != null ? { borderRadius } : null),
        ...style,
      }}
    >
      {layer}
      <div className="lg-content">{children}</div>
    </div>
  )
}

function layerHostStyle(
  size: number | undefined,
  borderRadius: LiquidGlassProps['borderRadius'],
  style: CSSProperties | undefined,
): CSSProperties {
  // size ⇒ standalone circular lens centred in its parent; otherwise fill the parent.
  const sized: CSSProperties | undefined =
    size != null ? { width: size, height: size, margin: 'auto', borderRadius: size / 2 } : undefined
  return { ...sized, ...(borderRadius != null ? { borderRadius } : null), ...style }
}

export const LiquidGlass = memo(LiquidGlassImpl)
