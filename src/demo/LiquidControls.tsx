import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { LiquidGlass, type LiquidGlassProps } from '../glass'

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

interface LiquidSwitchProps {
  checked: boolean
  onChange: (next: boolean) => void
  glass: LiquidGlassProps
  refractionTarget: RefObject<HTMLElement | null>
  ariaLabel?: string
  ariaLabelledBy?: string
}

/**
 * Apple iOS 26/27 Liquid Glass switch: slim recessed track with a protruding
 * refractive crystal capsule thumb supporting both tap-to-toggle and pointer scrubbing.
 */
export function LiquidSwitch({
  checked,
  onChange,
  glass,
  refractionTarget,
  ariaLabel,
  ariaLabelledBy,
}: LiquidSwitchProps) {
  const thumbRef = useRef<HTMLSpanElement>(null)
  const [pressed, setPressed] = useState(false)
  const [scrubbing, setScrubbing] = useState(false)
  const dragRef = useRef<{
    id: number
    startX: number
    startRatio: number
    lastChecked: boolean
    moved: boolean
  } | null>(null)
  const suppressClickRef = useRef(false)

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      dragRef.current = {
        id: e.pointerId,
        startX: e.clientX,
        startRatio: checked ? 1 : 0,
        lastChecked: checked,
        moved: false,
      }
      setPressed(true)
    },
    [checked],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      const d = dragRef.current
      const thumb = thumbRef.current
      if (!d || d.id !== e.pointerId || !thumb) return
      const dx = e.clientX - d.startX
      if (!d.moved && Math.abs(dx) > 4) {
        d.moved = true
        setScrubbing(true)
        e.currentTarget.setPointerCapture(e.pointerId)
      }
      if (!d.moved) return

      // Pressed travel runs from -2px (OFF) to 28px (ON) across the 76px switch hit box
      const ratio = clamp(d.startRatio + dx / 30, 0, 1)
      thumb.style.transform = `translate3d(${(-2 + ratio * 30).toFixed(2)}px, 0, 0)`
      const nextChecked = ratio >= 0.5
      if (nextChecked !== d.lastChecked) {
        d.lastChecked = nextChecked
        onChange(nextChecked)
      }
    },
    [onChange],
  )

  const finishDrag = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current
    if (!d || d.id !== e.pointerId) return
    dragRef.current = null
    if (d.moved) {
      suppressClickRef.current = true
      setTimeout(() => {
        suppressClickRef.current = false
      }, 0)
    }
    if (thumbRef.current) {
      thumbRef.current.style.transform = ''
    }
    setPressed(false)
    setScrubbing(false)
  }, [])

  const onClick = useCallback(() => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    onChange(!checked)
  }, [checked, onChange])

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      className="liquid-switch"
      data-checked={checked ? 'true' : 'false'}
      data-pressed={pressed ? 'true' : 'false'}
      data-scrubbing={scrubbing ? 'true' : undefined}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onPointerLeave={() => {
        if (!dragRef.current?.moved) setPressed(false)
      }}
    >
      <span className="liquid-switch-track" aria-hidden="true" />
      <span ref={thumbRef} className="liquid-switch-thumb" data-lg-ignore="" aria-hidden="true">
        <LiquidGlass
          mode="layer"
          refractionTarget={refractionTarget}
          strength={Math.max(glass.strength ?? 0.08, 0.14)}
          curvature={0.96}
          depth={8}
          splay={0.86}
          chroma={Math.max(glass.chroma ?? 0.85, 0.85)}
          blur={Math.min(glass.blur ?? 0, 1.5)}
          edgeHighlight={Math.max(glass.edgeHighlight ?? 0.9, 0.95)}
          glow={Math.max(glass.glow ?? 0.8, 0.95)}
          specularAngle={glass.specularAngle}
          specularMode={glass.specularMode}
        />
      </span>
    </button>
  )
}

interface LiquidSegmentedControlProps<T extends string> {
  options: readonly T[]
  value: T
  onChange: (next: T) => void
  glass: LiquidGlassProps
  refractionTarget: RefObject<HTMLElement | null>
  tint?: string
  ariaLabel: string
}

/**
 * Apple Liquid Glass segmented control: continuous dark pill track with a single lifted,
 * overhanging refractive lens capsule that glides or scrubs smoothly across segments.
 */
export function LiquidSegmentedControl<T extends string>({
  options,
  value,
  onChange,
  glass,
  refractionTarget,
  tint,
  ariaLabel,
}: LiquidSegmentedControlProps<T>) {
  const trackRef = useRef<HTMLDivElement>(null)
  const thumbRef = useRef<HTMLDivElement>(null)
  const colWidthRef = useRef(0)
  const [scrubbing, setScrubbing] = useState(false)
  const dragRef = useRef<{ id: number; startX: number; moved: boolean } | null>(null)
  const suppressClickRef = useRef(false)

  const activeIndex = Math.max(0, options.indexOf(value))

  const syncThumbGeometry = useCallback(() => {
    const track = trackRef.current
    const thumb = thumbRef.current
    if (!track || !thumb || options.length === 0) return
    const trackWidth = track.getBoundingClientRect().width || track.offsetWidth
    if (trackWidth <= 0) return
    const colWidth = trackWidth / options.length
    colWidthRef.current = colWidth
    thumb.style.width = `${colWidth + 10}px`
    if (!dragRef.current?.moved) {
      thumb.style.transform = `translate3d(${(activeIndex * colWidth).toFixed(2)}px, 0, 0)`
    }
  }, [activeIndex, options.length])

  useLayoutEffect(() => {
    syncThumbGeometry()
    const track = trackRef.current
    if (!track) return
    const ro = new ResizeObserver(syncThumbGeometry)
    ro.observe(track)
    return () => ro.disconnect()
  }, [syncThumbGeometry])

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = { id: e.pointerId, startX: e.clientX, moved: false }
  }, [])

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const d = dragRef.current
      const track = trackRef.current
      const thumb = thumbRef.current
      if (!d || d.id !== e.pointerId || !track || !thumb) return
      const dx = e.clientX - d.startX
      if (!d.moved && Math.abs(dx) > 4) {
        d.moved = true
        setScrubbing(true)
        e.currentTarget.setPointerCapture(e.pointerId)
      }
      if (!d.moved) return

      const rect = track.getBoundingClientRect()
      const col = (rect.width || colWidthRef.current * options.length) / options.length
      if (col <= 0) return
      const pos = clamp((e.clientX - rect.left) / col - 0.5, 0, options.length - 1)
      thumb.style.transform = `translate3d(${(pos * col).toFixed(2)}px, 0, 0) scale(1.03)`
      const nextIdx = Math.round(pos)
      const nextOption = options[nextIdx]
      if (nextOption && nextOption !== value) {
        onChange(nextOption)
      }
    },
    [onChange, options, value],
  )

  const finishScrub = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const d = dragRef.current
      if (!d || d.id !== e.pointerId) return
      dragRef.current = null
      if (d.moved) {
        suppressClickRef.current = true
        setTimeout(() => {
          suppressClickRef.current = false
        }, 0)
      }
      setScrubbing(false)
      if (thumbRef.current && colWidthRef.current > 0) {
        thumbRef.current.style.transform = `translate3d(${(activeIndex * colWidthRef.current).toFixed(2)}px, 0, 0)`
      }
    },
    [activeIndex],
  )

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="liquid-seg"
      data-scrubbing={scrubbing ? 'true' : undefined}
      style={
        {
          '--seg-count': options.length,
          '--seg-index': activeIndex,
        } as CSSProperties
      }
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishScrub}
      onPointerCancel={finishScrub}
    >
      <div ref={trackRef} className="liquid-seg-track" aria-hidden="true" />
      <div ref={thumbRef} className="liquid-seg-thumb" data-lg-ignore="" aria-hidden="true">
        <LiquidGlass
          mode="layer"
          refractionTarget={refractionTarget}
          tint={tint}
          strength={Math.max(glass.strength ?? 0.08, 0.13)}
          curvature={0.96}
          depth={10}
          splay={0.85}
          chroma={Math.max(glass.chroma ?? 0.85, 0.85)}
          blur={0}
          edgeHighlight={Math.max(glass.edgeHighlight ?? 0.9, 0.95)}
          glow={Math.max(glass.glow ?? 0.8, 0.95)}
          specularAngle={glass.specularAngle}
          specularMode={glass.specularMode}
        />
      </div>
      {options.map((option) => {
        const selected = option === value
        return (
          <button
            key={option}
            type="button"
            role="tab"
            aria-selected={selected}
            className={'liquid-seg-btn' + (selected ? ' liquid-seg-btn--on' : '')}
            onClick={() => {
              if (suppressClickRef.current) {
                suppressClickRef.current = false
                return
              }
              onChange(option)
            }}
          >
            {option}
          </button>
        )
      })}
    </div>
  )
}

