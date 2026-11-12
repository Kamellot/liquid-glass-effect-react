import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react'
import { getTargetSnapshot, subscribeTargetSnapshot } from './domSnapshot'
import {
  acquireBevelField,
  chooseRenderScale,
  generateDisplacementMap,
  releaseBevelField,
  renderRefractedBevel,
  type BevelField,
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
  specularMode = DEFAULTS.specularMode,
  refractionTarget,
  children,
  className,
  style,
  onMapUpdate,
}: LiquidGlassProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fieldRef = useRef<BevelField | null>(null)
  const outImageRef = useRef<ImageData | null>(null)
  const parentTintRef = useRef<string>('')
  const opticsRef = useRef({ strength, chroma })
  opticsRef.current = { strength, chroma }

  const onMapUpdateRef = useRef(onMapUpdate)
  onMapUpdateRef.current = onMapUpdate

  const [metrics, setMetrics] = useState<BoxMetrics>({ width: 0, height: 0, borderRadius: 0 })
  const [targetEl, setTargetEl] = useState<HTMLElement | null>(null)

  const hasChildren = children !== undefined && children !== null
  const isStandalone = mode === 'wrapper' && !hasChildren
  const explicitSize = mode === 'wrapper' ? size : undefined

  useLayoutEffect(() => {
    setTargetEl(resolveTarget(refractionTarget))
  }, [refractionTarget])

  // Track box dimensions and computed border-radius via ResizeObserver
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

  const drawFrame = useCallback(() => {
    const canvas = canvasRef.current
    const root = rootRef.current
    const field = fieldRef.current
    if (!canvas || !root || !field || !targetEl) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    if (canvas.width !== field.bufWidth) canvas.width = field.bufWidth
    if (canvas.height !== field.bufHeight) canvas.height = field.bufHeight

    const { strength: curStrength, chroma: curChroma } = opticsRef.current
    const snapshot = getTargetSnapshot(targetEl)
    if (!snapshot || curStrength <= 0.0001) {
      ctx.clearRect(0, 0, field.bufWidth, field.bufHeight)
      return
    }

    if (
      !outImageRef.current ||
      outImageRef.current.width !== field.bufWidth ||
      outImageRef.current.height !== field.bufHeight
    ) {
      outImageRef.current = ctx.createImageData(field.bufWidth, field.bufHeight)
    }

    const rootRect = root.getBoundingClientRect()
    const targetRect = targetEl.getBoundingClientRect()
    const offsetX = rootRect.left - targetRect.left
    const offsetY = rootRect.top - targetRect.top

    renderRefractedBevel(
      ctx,
      outImageRef.current,
      field,
      snapshot,
      offsetX,
      offsetY,
      curStrength,
      curChroma,
    )

    if (parentTintRef.current) {
      ctx.save()
      ctx.globalCompositeOperation = 'source-atop'
      ctx.fillStyle = parentTintRef.current
      ctx.fillRect(0, 0, field.bufWidth, field.bufHeight)
      ctx.restore()
    }
  }, [targetEl])

  // Acquire shared 1/4-SDF bevel field before paint & emit debug R/G map
  useLayoutEffect(() => {
    const { width, height, borderRadius } = metrics
    if (width < 2 || height < 2) {
      fieldRef.current = null
      return
    }

    if (!targetEl) {
      fieldRef.current = null
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
          fieldId: opticsRef.current.strength > 0.0001 ? 'css-optics' : null,
          dataUrl: dataUrl || null,
          width,
          height,
          borderRadius,
          hash: 'no-target',
        })
      }
      return
    }

    const scale = chooseRenderScale(width, height, depth)
    const { field, dataUrl } = acquireBevelField({
      width,
      height,
      borderRadius,
      depth,
      curvature,
      splay,
      scale,
    })

    fieldRef.current = field
    drawFrame()

    onMapUpdateRef.current?.({
      fieldId: opticsRef.current.strength > 0.0001 && curvature > 0.001 ? field.fieldId : null,
      dataUrl: dataUrl || null,
      width,
      height,
      borderRadius,
      hash: field.hash,
    })

    return () => {
      releaseBevelField(field.hash)
      if (fieldRef.current === field) {
        fieldRef.current = null
      }
    }
  }, [targetEl, metrics, depth, curvature, splay, drawFrame])

  // Redraw immediately when optical strength/chroma changes without regenerating bevel field
  useLayoutEffect(() => {
    drawFrame()
    const field = fieldRef.current
    if (field && onMapUpdateRef.current && targetEl) {
      const dataUrl = generateDisplacementMap({
        width: field.width,
        height: field.height,
        borderRadius: field.borderRadius,
        depth,
        curvature,
        splay,
      })
      onMapUpdateRef.current({
        fieldId: strength > 0.0001 && curvature > 0.001 ? field.fieldId : null,
        dataUrl: dataUrl || null,
        width: field.width,
        height: field.height,
        borderRadius: field.borderRadius,
        hash: field.hash,
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strength, chroma, drawFrame])

  // Subscribe to shared target snapshot + track parent/ancestor movement with zero-frame drag sync
  useLayoutEffect(() => {
    if (!targetEl) return
    const root = rootRef.current
    if (!root) return

    let scrollRaf = 0

    const syncParentTint = () => {
      if (mode !== 'layer' || !root.parentElement) {
        parentTintRef.current = ''
        return
      }
      const bg = getComputedStyle(root.parentElement).backgroundColor
      parentTintRef.current = isTransparentBg(bg) ? '' : bg
    }

    const unsubSnapshot = subscribeTargetSnapshot(targetEl, drawFrame)
    syncParentTint()
    drawFrame()

    const scheduleScrollDraw = () => {
      if (!scrollRaf) {
        scrollRaf = requestAnimationFrame(() => {
          scrollRaf = 0
          drawFrame()
        })
      }
    }

    const posRo = new ResizeObserver(drawFrame)
    posRo.observe(root)

    // Synchronous redraw inside mutation microtask ensures zero trailing during translate3d drag
    const ancestorMo = new MutationObserver((records) => {
      for (const rec of records) {
        if (rec.target === root.parentElement) {
          syncParentTint()
          break
        }
      }
      drawFrame()
    })

    let cur: HTMLElement | null = root
    while (cur && cur !== document.documentElement) {
      ancestorMo.observe(cur, {
        attributes: true,
        attributeFilter: ['style', 'class', 'data-tinted'],
      })
      cur = cur.parentElement
    }

    const parentEl = root.parentElement
    const onTransitionEnd = () => {
      syncParentTint()
      drawFrame()
    }

    parentEl?.addEventListener('transitionend', onTransitionEnd)
    window.addEventListener('scroll', scheduleScrollDraw, { passive: true, capture: true })
    window.addEventListener('resize', scheduleScrollDraw, { passive: true })

    return () => {
      if (scrollRaf) cancelAnimationFrame(scrollRaf)
      unsubSnapshot()
      posRo.disconnect()
      ancestorMo.disconnect()
      parentEl?.removeEventListener('transitionend', onTransitionEnd)
      window.removeEventListener('scroll', scheduleScrollDraw, true)
      window.removeEventListener('resize', scheduleScrollDraw)
    }
  }, [targetEl, mode, drawFrame])

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
      data-lg-engine={targetEl ? 'canvas-sdf' : 'css-optics'}
      className={rootClassName}
      style={rootStyle}
      aria-hidden={isLayer ? 'true' : undefined}
    >
      {targetEl && (
        <div className="lg-refract-clip" aria-hidden="true">
          <canvas ref={canvasRef} className="lg-refract-canvas" />
        </div>
      )}

      {blur > 0.05 && <div className="lg-frost" aria-hidden="true" />}

      {glow > 0.001 && (
        <div
          className={specularMode === 'apple' ? 'lg-glow lg-glow--apple' : 'lg-glow'}
          aria-hidden="true"
        />
      )}
      {edgeHighlight > 0.001 && (
        <div
          className={specularMode === 'apple' ? 'lg-rim lg-rim--apple' : 'lg-rim'}
          aria-hidden="true"
        />
      )}

      {hasChildren && <div className="lg-content">{children}</div>}
    </div>
  )
})
