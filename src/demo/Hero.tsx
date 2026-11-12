import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { GlassScene, LiquidGlass, type LiquidGlassProps } from '../glass'

/** Hero: huge type over a cosmic photo + a circular lens you can drag with pointer events. */
export function Hero({ lens }: { lens: LiquidGlassProps & { size: number } }) {
  const stageRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<HTMLDivElement>(null)
  const pos = useRef<{ x: number; y: number } | null>(null)
  const drag = useRef<{ id: number; dx: number; dy: number } | null>(null)
  const raf = useRef(0)

  const apply = useCallback(() => {
    raf.current = 0
    const h = handleRef.current
    const p = pos.current
    if (h && p) h.style.transform = `translate3d(${p.x - lens.size / 2}px, ${p.y - lens.size / 2}px, 0)`
  }, [lens.size])

  const schedule = useCallback(() => {
    if (!raf.current) raf.current = requestAnimationFrame(apply)
  }, [apply])

  const clampToStage = useCallback(() => {
    const s = stageRef.current
    const p = pos.current
    if (!s || !p) return
    p.x = Math.min(s.clientWidth, Math.max(0, p.x))
    p.y = Math.min(s.clientHeight, Math.max(0, p.y))
  }, [])

  // Initial placement: straddling the left edge of the photo, like the reference.
  useLayoutEffect(() => {
    const s = stageRef.current
    if (!s) return
    if (!pos.current) pos.current = { x: s.clientWidth * 0.27, y: s.clientHeight * 0.5 }
    clampToStage()
    apply()
  }, [apply, clampToStage])

  useEffect(() => {
    const s = stageRef.current
    if (!s) return
    const ro = new ResizeObserver(() => {
      clampToStage()
      schedule()
    })
    ro.observe(s)
    return () => ro.disconnect()
  }, [clampToStage, schedule])

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = stageRef.current
    const p = pos.current
    if (!s || !p) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const r = s.getBoundingClientRect()
    drag.current = { id: e.pointerId, dx: p.x - (e.clientX - r.left), dy: p.y - (e.clientY - r.top) }
    e.currentTarget.dataset.dragging = 'true'
  }
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    const s = stageRef.current
    if (!d || d.id !== e.pointerId || !s || !pos.current) return
    const r = s.getBoundingClientRect()
    pos.current.x = e.clientX - r.left + d.dx
    pos.current.y = e.clientY - r.top + d.dy
    clampToStage()
    schedule()
  }
  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id === e.pointerId) {
      drag.current = null
      delete e.currentTarget.dataset.dragging
    }
  }

  const onKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 40 : 12
    const d: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }
    const v = d[e.key]
    if (!v || !pos.current) return
    e.preventDefault()
    pos.current.x += v[0]
    pos.current.y += v[1]
    clampToStage()
    schedule()
  }

  return (
    <section className="hero" aria-labelledby="hero-title">
        <GlassScene className="hero-stage" elRef={stageRef}>
          <div className="hero-photo" role="img" aria-label="Cosmic nebula photograph" />
          <h1 id="hero-title" className="hero-title">
            It refracts anything
            <br />— even DOM
          </h1>
          <p className="hero-sub">
            The circle starts here. Drag it across the text and the photo boundary — every pixel underneath is bent in real time
            by an analytical SDF (SVG displacement on Chromium, WebGL shader on Safari &amp; iOS).
          </p>
          <div
            ref={handleRef}
            data-glass-ignore=""
            className="lens-handle"
            style={{ width: lens.size, height: lens.size }}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onKeyDown={onKey}
            aria-label="Draggable glass lens (arrow keys move it)"
            tabIndex={0}
          >
            <LiquidGlass mode="wrapper" {...lens} />
          </div>
    </GlassScene>
    </section >
  )
}
