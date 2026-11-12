import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react'
import {
  acquireFilter,
  generateDisplacementMap,
  releaseFilter,
  supportsBackdropSvgFilter,
} from './refractionEngine'
import { DEFAULTS, type LiquidGlassProps } from './types'
import './LiquidGlass.css'

interface BoxMetrics {
  width: number
  height: number
  borderRadius: number
}

function resolveTarget(
  target: RefObject<HTMLElement | null> | HTMLElement | null | undefined,
): HTMLElement | null {
  if (!target) return null
  if ('current' in target) return target.current
  return target
}

function parseRadiusValue(raw: string, refDim: number): number {
  const token = raw.trim().split(/\s+/)[0]
  if (!token) return 0
  const val = parseFloat(token)
  if (!Number.isFinite(val)) return 0
  return token.endsWith('%') ? (val / 100) * refDim : val
}

function measureElementBox(el: HTMLElement): BoxMetrics {
  const width = Math.max(0, Math.round(el.offsetWidth || el.getBoundingClientRect().width))
  const height = Math.max(0, Math.round(el.offsetHeight || el.getBoundingClientRect().height))
  if (width === 0 || height === 0) {
    return { width: 0, height: 0, borderRadius: 0 }
  }
  const cs = getComputedStyle(el)
  const minDim = Math.min(width, height)
  const rTL = parseRadiusValue(cs.borderTopLeftRadius, minDim)
  const rTR = parseRadiusValue(cs.borderTopRightRadius, minDim)
  const rBR = parseRadiusValue(cs.borderBottomRightRadius, minDim)
  const rBL = parseRadiusValue(cs.borderBottomLeftRadius, minDim)
  const rawMax = Math.max(rTL, rTR, rBR, rBL)
  const borderRadius = Math.max(0, Math.min(rawMax, minDim * 0.5))
  return { width, height, borderRadius }
}

function isTransparentBg(bg: string): boolean {
  return !bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)'
}

function cloneTargetIntoMirror(target: HTMLElement, host: HTMLElement): void {
  const clone = target.cloneNode(true) as HTMLElement
  clone.removeAttribute('id')
  clone.style.margin = '0'
  clone.style.position = 'relative'
  clone.style.left = '0'
  clone.style.top = '0'
  clone.style.width = `${target.offsetWidth}px`
  clone.style.height = `${target.offsetHeight}px`
  clone.style.pointerEvents = 'none'

  clone.querySelectorAll('[data-lg-root], [data-lg-ignore]').forEach((node) => node.remove())
  clone.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'))
  host.replaceChildren(clone)
}

export const LiquidGlass = memo(function LiquidGlass({
  mode = 'layer',
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
  refractionTarget,
  children,
  className,
  style,
  onMapUpdate,
}: LiquidGlassProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const mirrorHostRef = useRef<HTMLDivElement>(null)
  const onMapUpdateRef = useRef(onMapUpdate)
  onMapUpdateRef.current = onMapUpdate

  const [metrics, setMetrics] = useState<BoxMetrics>({ width: 0, height: 0, borderRadius: 0 })
  const [filterId, setFilterId] = useState<string | null>(null)
  const [targetEl, setTargetEl] = useState<HTMLElement | null>(null)
  const [parentTint, setParentTint] = useState<string>('')

  const hasChildren = children !== undefined && children !== null
  const isStandalone = mode === 'wrapper' && !hasChildren
  const explicitSize = mode === 'wrapper' ? size : undefined

  // Resolve refractionTarget after commit
  useLayoutEffect(() => {
    setTargetEl(resolveTarget(refractionTarget))
  }, [refractionTarget])

  // Universal cross-browser target refraction when refractionTarget is present;
  // otherwise native Chromium backdrop-filter SVG or pure CSS optics.
  const path = targetEl
    ? 'target-svg'
    : supportsBackdropSvgFilter()
      ? 'backdrop-svg'
      : 'css-optics'

  // Track element dimensions and border-radius via ResizeObserver
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return

    const update = () => {
      const next = measureElementBox(el)
      setMetrics((prev) =>
        prev.width === next.width && prev.height === next.height && prev.borderRadius === next.borderRadius
          ? prev
          : next,
      )
    }

    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    if (el.parentElement) ro.observe(el.parentElement)
    return () => ro.disconnect()
  }, [mode, explicitSize, isStandalone, className, style?.borderRadius])

  // Acquire deduplicated SVG filter & generate 1/4-quadrant SDF displacement bitmap
  useEffect(() => {
    const { width, height, borderRadius } = metrics
    if (width < 2 || height < 2) {
      setFilterId(null)
      return
    }

    if (strength <= 0.0001) {
      setFilterId(null)
      if (onMapUpdateRef.current) {
        const dataUrl = generateDisplacementMap({
          width,
          height,
          borderRadius,
          depth,
          curvature,
          splay,
        })
        onMapUpdateRef.current({
          filterId: null,
          dataUrl: dataUrl || null,
          width,
          height,
          borderRadius,
          hash: 'zero-strength',
        })
      }
      return
    }

    const acquired = acquireFilter({
      width,
      height,
      borderRadius,
      depth,
      curvature,
      splay,
      strength,
      chroma,
    })

    if (!acquired) {
      setFilterId(null)
      return
    }

    setFilterId(acquired.filterId)
    onMapUpdateRef.current?.({
      filterId: acquired.filterId,
      dataUrl: acquired.dataUrl,
      width,
      height,
      borderRadius,
      hash: acquired.hash,
    })

    return () => {
      releaseFilter(acquired.hash)
    }
  }, [metrics, depth, curvature, splay, strength, chroma])

  // Universal cross-browser target-layer refraction: clone target once & sync only (x, y) on drag/scroll
  useLayoutEffect(() => {
    if (path !== 'target-svg' || !targetEl) return
    const root = rootRef.current
    const host = mirrorHostRef.current
    if (!root || !host) return

    let cloneRaf = 0
    let posRaf = 0

    const syncClone = () => {
      cloneRaf = 0
      cloneTargetIntoMirror(targetEl, host)
    }

    const syncPosition = () => {
      posRaf = 0
      const rootRect = root.getBoundingClientRect()
      const targetRect = targetEl.getBoundingClientRect()
      const dx = rootRect.left - targetRect.left
      const dy = rootRect.top - targetRect.top
      host.style.transform = `translate3d(${-dx}px, ${-dy}px, 0)`
    }

    const syncParentTint = () => {
      if (mode !== 'layer' || !root.parentElement) {
        setParentTint('')
        return
      }
      const bg = getComputedStyle(root.parentElement).backgroundColor
      setParentTint(isTransparentBg(bg) ? '' : bg)
    }

    syncClone()
    syncPosition()
    syncParentTint()

    const schedulePos = () => {
      if (!posRaf) posRaf = requestAnimationFrame(syncPosition)
    }
    const scheduleClone = () => {
      if (!cloneRaf) cloneRaf = requestAnimationFrame(syncClone)
    }

    const targetRo = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === targetEl) {
          scheduleClone()
          break
        }
      }
      schedulePos()
    })
    targetRo.observe(targetEl)
    targetRo.observe(root)

    const targetMo = new MutationObserver((records) => {
      for (const rec of records) {
        const el = rec.target instanceof Element ? rec.target : rec.target.parentElement
        if (el && !el.closest('[data-lg-root], [data-lg-ignore]')) {
          scheduleClone()
          break
        }
      }
    })
    targetMo.observe(targetEl, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    })

    const ancestorMo = new MutationObserver((records) => {
      for (const rec of records) {
        if (rec.target === root.parentElement) {
          syncParentTint()
        }
      }
      syncPosition()
    })
    let cur: HTMLElement | null = root
    while (cur && cur !== document.documentElement) {
      ancestorMo.observe(cur, { attributes: true, attributeFilter: ['style', 'class', 'data-tinted'] })
      cur = cur.parentElement
    }

    const parentEl = root.parentElement
    parentEl?.addEventListener('transitionend', syncParentTint)
    window.addEventListener('scroll', schedulePos, { passive: true, capture: true })
    window.addEventListener('resize', schedulePos, { passive: true })

    return () => {
      if (cloneRaf) cancelAnimationFrame(cloneRaf)
      if (posRaf) cancelAnimationFrame(posRaf)
      targetRo.disconnect()
      targetMo.disconnect()
      ancestorMo.disconnect()
      parentEl?.removeEventListener('transitionend', syncParentTint)
      window.removeEventListener('scroll', schedulePos, true)
      window.removeEventListener('resize', schedulePos)
      host.replaceChildren()
    }
  }, [path, targetEl, mode])

  const rootStyle = useMemo<CSSProperties>(() => {
    const rad = ((specularAngle - 90) * Math.PI) / 180
    const lx = Math.cos(rad)
    const ly = Math.sin(rad)

    const vars: Record<string, string | number> = {
      '--lg-blur': `${Math.max(0, blur).toFixed(1)}px`,
      '--lg-edge-highlight': Math.max(0, Math.min(1, edgeHighlight)),
      '--lg-specular-angle': `${specularAngle}deg`,
      '--lg-glow': Math.max(0, Math.min(1, glow)),
      '--lg-lx': lx.toFixed(4),
      '--lg-ly': ly.toFixed(4),
    }

    const sizeStyles: CSSProperties =
      explicitSize !== undefined
        ? {
            width: explicitSize,
            height: explicitSize,
            borderRadius: '50%',
          }
        : {}

    return {
      ...sizeStyles,
      ...style,
      ...vars,
    } as CSSProperties
  }, [blur, edgeHighlight, specularAngle, glow, explicitSize, style])

  const backdropStyle = useMemo<CSSProperties | undefined>(() => {
    if (path !== 'backdrop-svg' || !filterId) return undefined
    const filterValue =
      blur > 0.05
        ? `url(#${filterId}) blur(${blur.toFixed(1)}px) saturate(180%)`
        : `url(#${filterId})`
    return {
      backdropFilter: filterValue,
      WebkitBackdropFilter: filterValue,
    }
  }, [path, filterId, blur])

  const showSeparateFrost = blur > 0.05 && !(path === 'backdrop-svg' && filterId)
  const isLayer = mode === 'layer'

  const rootClassName = [
    'lg-root',
    isLayer ? 'lg-root--layer' : 'lg-root--wrapper',
    isStandalone ? 'lg-root--standalone' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      ref={rootRef}
      data-lg-root=""
      data-lg-path={path}
      className={rootClassName}
      style={rootStyle}
      aria-hidden={isLayer ? 'true' : undefined}
    >
      {path === 'backdrop-svg' && filterId && (
        <div className="lg-backdrop" style={backdropStyle} aria-hidden="true" />
      )}

      {path === 'target-svg' && (
        <div className="lg-target-clip" aria-hidden="true">
          <div
            className="lg-target-filter"
            style={filterId ? { filter: `url(#${filterId})` } : undefined}
          >
            <div ref={mirrorHostRef} className="lg-target-mirror" />
          </div>
          {parentTint && (
            <div className="lg-target-tint" style={{ backgroundColor: parentTint }} />
          )}
        </div>
      )}

      {showSeparateFrost && <div className="lg-frost" aria-hidden="true" />}

      {glow > 0.001 && <div className="lg-glow" aria-hidden="true" />}
      {edgeHighlight > 0.001 && <div className="lg-rim" aria-hidden="true" />}

      {hasChildren && <div className="lg-content">{children}</div>}
    </div>
  )
})
