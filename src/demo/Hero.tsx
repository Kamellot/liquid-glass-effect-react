import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { DEFAULTS, LiquidGlass, type DisplacementMapInfo, type LiquidGlassProps } from '../glass'

interface HeroProps {
  lens: LiquidGlassProps & { size: number }
}

/** Hero showcase: huge typography overlapping a cosmic image + draggable lens + live R/G displacement preview. */
export function Hero({ lens }: HeroProps) {
  const stageRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<HTMLDivElement>(null)
  const pos = useRef<{ x: number; y: number } | null>(null)
  const drag = useRef<{ id: number; dx: number; dy: number } | null>(null)
  const raf = useRef(0)

  const [mapInfo, setMapInfo] = useState<DisplacementMapInfo | null>(null)

  const applyPosition = useCallback(() => {
    raf.current = 0
    const handle = handleRef.current
    const p = pos.current
    if (handle && p) {
      handle.style.transform = `translate3d(${p.x - lens.size / 2}px, ${p.y - lens.size / 2}px, 0)`
    }
  }, [lens.size])

  const schedulePosition = useCallback(() => {
    if (!raf.current) raf.current = requestAnimationFrame(applyPosition)
  }, [applyPosition])

  const clampToStage = useCallback(() => {
    const stage = stageRef.current
    const p = pos.current
    if (!stage || !p) return
    p.x = Math.min(stage.clientWidth, Math.max(0, p.x))
    p.y = Math.min(stage.clientHeight, Math.max(0, p.y))
  }, [])

  useLayoutEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    if (!pos.current) {
      pos.current = { x: stage.clientWidth * 0.27, y: stage.clientHeight * 0.5 }
    }
    clampToStage()
    applyPosition()
  }, [applyPosition, clampToStage])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const ro = new ResizeObserver(() => {
      clampToStage()
      schedulePosition()
    })
    ro.observe(stage)
    return () => {
      ro.disconnect()
      if (raf.current) cancelAnimationFrame(raf.current)
    }
  }, [clampToStage, schedulePosition])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const stage = stageRef.current
    const p = pos.current
    if (!stage || !p) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const rect = stage.getBoundingClientRect()
    drag.current = {
      id: e.pointerId,
      dx: p.x - (e.clientX - rect.left),
      dy: p.y - (e.clientY - rect.top),
    }
    e.currentTarget.dataset.dragging = 'true'
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    const stage = stageRef.current
    if (!d || d.id !== e.pointerId || !stage || !pos.current) return
    const rect = stage.getBoundingClientRect()
    pos.current.x = e.clientX - rect.left + d.dx
    pos.current.y = e.clientY - rect.top + d.dy
    clampToStage()
    schedulePosition()
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id === e.pointerId) {
      drag.current = null
      delete e.currentTarget.dataset.dragging
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 40 : 12
    const deltas: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }
    const delta = deltas[e.key]
    if (!delta || !pos.current) return
    e.preventDefault()
    pos.current.x += delta[0]
    pos.current.y += delta[1]
    clampToStage()
    schedulePosition()
  }

  const rawDepth = lens.depth ?? DEFAULTS.depth
  const domeDepth =
    rawDepth <= 0
      ? 0
      : Math.min(
          Math.round(lens.size * 0.5),
          Math.max(rawDepth, Math.round(Math.pow(rawDepth / 100, 0.6) * (lens.size * 0.5) * 1.32)),
        )

  return (
    <section className="hero" aria-labelledby="hero-title">
      <div ref={stageRef} className="hero-stage">
        <div className="hero-photo" role="img" aria-label="Cosmic nebula photograph" />

        <h1 id="hero-title" className="hero-title">
          It refracts anything
          <br />
          — even DOM
        </h1>

        <p className="hero-sub">
          Drag the circular lens across typography and the cosmic boundary. A custom 1/4-quadrant SDF bevel engine bends
          pixels on <code>&lt;canvas&gt;</code> across every browser, while frost, the directional rim light, and inner reflection run in CSS.
        </p>

        <div
          ref={handleRef}
          data-lg-ignore=""
          className="lens-handle"
          style={{ width: lens.size, height: lens.size }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={onKeyDown}
          aria-label="Draggable glass lens (use pointer or arrow keys to move)"
          tabIndex={0}
        >
          <LiquidGlass
            mode="wrapper"
            refractionTarget={stageRef}
            onMapUpdate={setMapInfo}
            {...lens}
            depth={domeDepth}
          />
        </div>

        <aside className="debug-preview" aria-label="Live displacement map debug preview">
          <div className="debug-thumb">
            {mapInfo?.dataUrl ? (
              <img src={mapInfo.dataUrl} alt="Live generated R/G SDF displacement map texture" />
            ) : (
              <span className="debug-empty">—</span>
            )}
          </div>
          <div className="debug-meta">
            <div className="debug-title">R/G Displacement Map</div>
            <div className="debug-row">
              {mapInfo ? `${mapInfo.width}×${mapInfo.height}px · r${Math.round(mapInfo.borderRadius)}` : 'Initializing…'}
              {` · depth ${domeDepth}px`}
            </div>
            <div className="debug-row debug-row--muted">
              <span>1/4 SDF mirrored</span>
              <span>·</span>
              <code>{mapInfo?.fieldId ? `#${mapInfo.fieldId}` : 'neutral'}</code>
            </div>
            <div className="debug-legend">
              <span className="legend-r">R: ΔX</span>
              <span className="legend-g">G: ΔY</span>
              <span className="legend-n">128 = 0</span>
            </div>
          </div>
        </aside>
      </div>
    </section>
  )
}

