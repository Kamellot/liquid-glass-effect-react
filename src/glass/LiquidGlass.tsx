import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react'
import { getTargetSnapshot, isTransparent, notifyGlassRedrawn, subscribeTargetSnapshot } from './domSnapshot'
import {
  acquireBevelField,
  chooseRenderScale,
  generateDisplacementMap,
  releaseBevelField,
  renderRefractedBevel,
  type BevelField,
} from './refractionEngine'
import { isWebGLRefractionAvailable } from './webglRefraction'
import {
  cancelGlassDraw,
  observeGlassIntersection,
  observeGlassResize,
  scheduleGlassDraw,
} from './glassScheduler'
import { useLiquidGlassConfig } from './LiquidGlassContext'
import { DEFAULTS, FIGMA_MATERIAL_DEFAULTS, type LiquidGlassProps } from './types'
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

export const LiquidGlass = memo(function LiquidGlass({
  mode = 'layer',
  ignoreGlobal = false,
  size: sizeProp,
  refraction: refractionProp,
  depth: depthProp,
  dispersion: dispersionProp,
  frost: frostProp,
  splay: splayProp,
  lightMode: lightModeProp,
  lightAngle: lightAngleProp,
  lightIntensity: lightIntensityProp,
  glow: glowProp,
  borderRadius: borderRadiusPropProp,
  tint: tintProp,
  fill: fillProp,
  fillOverlay: fillOverlayProp,
  shadow: shadowProp,
  refractionTarget,
  children,
  className,
  style,
  onMapUpdate,
}: LiquidGlassProps) {
  const globalConfig = useLiquidGlassConfig()
  const activeGlobal = ignoreGlobal ? undefined : globalConfig

  const size = sizeProp ?? activeGlobal?.size
  const refraction = refractionProp ?? activeGlobal?.refraction ?? DEFAULTS.refraction
  const depth = depthProp ?? activeGlobal?.depth ?? DEFAULTS.depth
  const dispersion = dispersionProp ?? activeGlobal?.dispersion ?? DEFAULTS.dispersion
  const frost = frostProp ?? activeGlobal?.frost ?? DEFAULTS.frost
  const splay = splayProp ?? activeGlobal?.splay ?? DEFAULTS.splay
  const lightMode = lightModeProp ?? activeGlobal?.lightMode ?? DEFAULTS.lightMode
  const lightAngle = lightAngleProp ?? activeGlobal?.lightAngle ?? DEFAULTS.lightAngle
  const lightIntensity = lightIntensityProp ?? activeGlobal?.lightIntensity ?? DEFAULTS.lightIntensity
  const glow = glowProp ?? activeGlobal?.glow ?? DEFAULTS.glow
  const borderRadiusProp = borderRadiusPropProp ?? activeGlobal?.borderRadius
  const tint = tintProp ?? activeGlobal?.tint
  const fill = fillProp ?? activeGlobal?.fill
  const fillOverlay = fillOverlayProp ?? activeGlobal?.fillOverlay
  const shadow = shadowProp ?? activeGlobal?.shadow
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fieldRef = useRef<BevelField | null>(null)
  const outImageRef = useRef<ImageData | null>(null)
  const parentTintRef = useRef<string>('')
  const isVisibleRef = useRef<boolean>(true)
  const lastDrawRef = useRef<{
    version: number
    offsetX: number
    offsetY: number
    refraction: number
    dispersion: number
    tint: string
    fieldHash: string
  } | null>(null)
  const opticsRef = useRef({ refraction, dispersion })
  opticsRef.current = { refraction, dispersion }

  const onMapUpdateRef = useRef(onMapUpdate)
  onMapUpdateRef.current = onMapUpdate

  const [metrics, setMetrics] = useState<BoxMetrics>({ width: 0, height: 0, borderRadius: 0 })
  const [targetEl, setTargetEl] = useState<HTMLElement | null>(null)

  const hasChildren = children !== undefined && children !== null
  const isStandalone = mode === 'wrapper' && !hasChildren
  const explicitSize = mode === 'wrapper' ? size : undefined

  // Sync resolved refractionTarget after mount/commit (parent RefObjects attach after child useLayoutEffect in React 19)
  useLayoutEffect(() => {
    const resolved = resolveTarget(refractionTarget)
    setTargetEl((prev) => (prev === resolved ? prev : resolved))
  })

  useEffect(() => {
    const resolved = resolveTarget(refractionTarget)
    setTargetEl((prev) => (prev === resolved ? prev : resolved))
  })

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
    const unsubEl = observeGlassResize(el, update)
    const unsubParent = el.parentElement ? observeGlassResize(el.parentElement, update) : undefined
    return () => {
      unsubEl()
      unsubParent?.()
    }
  }, [mode, explicitSize, isStandalone, className, style?.borderRadius, borderRadiusProp])

  const drawFrame = useCallback(() => {
    if (!isVisibleRef.current) return
    const canvas = canvasRef.current
    const root = rootRef.current
    const field = fieldRef.current
    if (!canvas || !root || !field || !targetEl) return

    const checkVis = (
      root as HTMLElement & {
        checkVisibility?: (opts?: { checkOpacity?: boolean; checkVisibilityCSS?: boolean }) => boolean
      }
    ).checkVisibility
    if (typeof checkVis === 'function' && !checkVis.call(root, { checkOpacity: true, checkVisibilityCSS: true })) {
      return
    }

    const rootRect = root.getBoundingClientRect()
    if (
      typeof window !== 'undefined' &&
      window.innerHeight > 0 &&
      (rootRect.bottom < -200 || rootRect.top > window.innerHeight + 200)
    ) {
      isVisibleRef.current = false
      if (!root.hasAttribute('data-lg-offscreen')) {
        root.setAttribute('data-lg-offscreen', '1')
      }
      return
    }
    if (root.hasAttribute('data-lg-offscreen')) {
      root.removeAttribute('data-lg-offscreen')
    }

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const { refraction: curRefraction, dispersion: curDispersion } = opticsRef.current
    const snapshot = getTargetSnapshot(targetEl, root)
    if (!snapshot || curRefraction <= 0.01) {
      if (canvas.width !== field.bufWidth) canvas.width = field.bufWidth
      if (canvas.height !== field.bufHeight) canvas.height = field.bufHeight
      ctx.clearRect(0, 0, field.bufWidth, field.bufHeight)
      lastDrawRef.current = null
      notifyGlassRedrawn(targetEl, root)
      return
    }

    const targetRect = targetEl.getBoundingClientRect()
    const offsetX = rootRect.left - targetRect.left
    const offsetY = rootRect.top - targetRect.top

    const prev = lastDrawRef.current
    if (
      prev &&
      prev.version === snapshot.version &&
      Math.abs(prev.offsetX - offsetX) < 0.25 &&
      Math.abs(prev.offsetY - offsetY) < 0.25 &&
      prev.refraction === curRefraction &&
      prev.dispersion === curDispersion &&
      prev.tint === parentTintRef.current &&
      prev.fieldHash === field.hash
    ) {
      return
    }

    if (canvas.width !== field.bufWidth) canvas.width = field.bufWidth
    if (canvas.height !== field.bufHeight) canvas.height = field.bufHeight

    if (
      !isWebGLRefractionAvailable() &&
      (!outImageRef.current ||
        outImageRef.current.width !== field.bufWidth ||
        outImageRef.current.height !== field.bufHeight)
    ) {
      outImageRef.current = ctx.createImageData(field.bufWidth, field.bufHeight)
    }

    renderRefractedBevel(
      ctx,
      outImageRef.current,
      field,
      snapshot,
      offsetX,
      offsetY,
      curRefraction,
      curDispersion,
      parentTintRef.current,
    )
    lastDrawRef.current = {
      version: snapshot.version,
      offsetX,
      offsetY,
      refraction: curRefraction,
      dispersion: curDispersion,
      tint: parentTintRef.current,
      fieldHash: field.hash,
    }
    notifyGlassRedrawn(targetEl, root)
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
          splay,
        })
        onMapUpdateRef.current({
          fieldId: opticsRef.current.refraction > 0.01 ? 'css-optics' : null,
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
    const { field, dataUrl } = acquireBevelField(
      {
        width,
        height,
        borderRadius,
        depth,
        splay,
        scale,
      },
      Boolean(onMapUpdateRef.current),
    )

    fieldRef.current = field
    drawFrame()

    onMapUpdateRef.current?.({
      fieldId: opticsRef.current.refraction > 0.01 && depth > 0.5 ? field.fieldId : null,
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
  }, [targetEl, metrics, depth, splay, drawFrame])

  // Redraw when refraction/dispersion change without regenerating the bevel field
  useLayoutEffect(() => {
    if (rootRef.current) {
      scheduleGlassDraw(rootRef.current, drawFrame)
    }
    const field = fieldRef.current
    if (field && onMapUpdateRef.current && targetEl) {
      const dataUrl = generateDisplacementMap({
        width: field.width,
        height: field.height,
        borderRadius: field.borderRadius,
        depth,
        splay,
      })
      onMapUpdateRef.current({
        fieldId: refraction > 0.01 && depth > 0.5 ? field.fieldId : null,
        dataUrl: dataUrl || null,
        width: field.width,
        height: field.height,
        borderRadius: field.borderRadius,
        hash: field.hash,
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refraction, dispersion, drawFrame])

  // Subscribe to shared target snapshot + track movement, tints & transitions with zero-frame lag
  useLayoutEffect(() => {
    if (!targetEl) return
    const root = rootRef.current
    if (!root) return

    let scrollRaf = 0
    let animRaf = 0
    let animDeadline = 0

    const syncTint = () => {
      const colorSource = tint !== undefined || mode !== 'layer' ? root : root.parentElement
      if (!colorSource) {
        parentTintRef.current = ''
        return
      }
      const bg = getComputedStyle(colorSource).backgroundColor
      parentTintRef.current = isTransparent(bg) ? '' : bg
    }

    const stopAnimLoop = () => {
      if (animRaf) {
        cancelAnimationFrame(animRaf)
        animRaf = 0
      }
    }

    const tickAnim = () => {
      animRaf = 0
      syncTint()
      drawFrame()
      if (performance.now() < animDeadline) {
        animRaf = requestAnimationFrame(tickAnim)
      }
    }

    const startAnimLoop = () => {
      animDeadline = performance.now() + 450
      if (!animRaf) animRaf = requestAnimationFrame(tickAnim)
    }

    const onTransitionFinish = () => {
      stopAnimLoop()
      syncTint()
      drawFrame()
    }

    const scheduleDraw = () => {
      if (!isVisibleRef.current) return
      scheduleGlassDraw(root, drawFrame)
    }

    const unsubSnapshot = subscribeTargetSnapshot(targetEl, scheduleDraw, root)
    syncTint()
    drawFrame()

    const unsubIo = observeGlassIntersection(root, (isIntersecting) => {
      const wasVisible = isVisibleRef.current
      isVisibleRef.current = isIntersecting
      if (isIntersecting) {
        if (root.hasAttribute('data-lg-offscreen')) {
          root.removeAttribute('data-lg-offscreen')
        }
        if (!wasVisible) {
          syncTint()
          scheduleGlassDraw(root, drawFrame)
        }
      } else if (!root.hasAttribute('data-lg-offscreen')) {
        root.setAttribute('data-lg-offscreen', '1')
      }
    })

    const needsScrollSync = (() => {
      if (!targetEl.contains(root)) return true
      let node: HTMLElement | null = root
      while (node && node !== targetEl) {
        const pos = getComputedStyle(node).position
        if (pos === 'fixed' || pos === 'sticky') return true
        node = node.parentElement
      }
      return false
    })()

    const unsubRo = observeGlassResize(root, scheduleDraw)

    // Synchronous redraw inside mutation microtask ensures zero trailing during translate3d drag
    const ancestorMo = new MutationObserver(() => {
      if (tint === undefined && mode === 'layer') {
        syncTint()
      }
      drawFrame()
    })

    const parentEl = root.parentElement
    ancestorMo.observe(root, { attributes: true, attributeFilter: ['style', 'class'] })
    if (parentEl && parentEl !== targetEl && parentEl !== document.documentElement) {
      ancestorMo.observe(parentEl, { attributes: true, attributeFilter: ['style', 'class'] })
    }

    root.addEventListener('transitionrun', startAnimLoop)
    root.addEventListener('transitionend', onTransitionFinish)
    root.addEventListener('transitioncancel', onTransitionFinish)
    parentEl?.addEventListener('transitionrun', startAnimLoop)
    parentEl?.addEventListener('transitionend', onTransitionFinish)
    parentEl?.addEventListener('transitioncancel', onTransitionFinish)
    if (needsScrollSync) {
      window.addEventListener('scroll', scheduleDraw, { passive: true, capture: true })
    }
    window.addEventListener('resize', scheduleDraw, { passive: true })

    return () => {
      if (scrollRaf) cancelAnimationFrame(scrollRaf)
      cancelGlassDraw(root)
      stopAnimLoop()
      unsubSnapshot()
      unsubIo()
      unsubRo()
      ancestorMo.disconnect()
      root.removeEventListener('transitionrun', startAnimLoop)
      root.removeEventListener('transitionend', onTransitionFinish)
      root.removeEventListener('transitioncancel', onTransitionFinish)
      parentEl?.removeEventListener('transitionrun', startAnimLoop)
      parentEl?.removeEventListener('transitionend', onTransitionFinish)
      parentEl?.removeEventListener('transitioncancel', onTransitionFinish)
      if (needsScrollSync) {
        window.removeEventListener('scroll', scheduleDraw, true)
      }
      window.removeEventListener('resize', scheduleDraw)
    }
  }, [targetEl, mode, tint, drawFrame])

  const rootStyle = useMemo<CSSProperties>(() => {
    // lightAngle 0 = light from the top; the CSS rim/glow treat the same angle as the highlight direction
    const rad = ((lightAngle - 90) * Math.PI) / 180
    const lx = Math.cos(rad)
    const ly = Math.sin(rad)
    const frostAmt = Math.max(0, Math.min(100, frost))
    const light = Math.max(0, Math.min(100, lightIntensity)) / 50
    const glowAmt = Math.max(0, Math.min(100, glow)) / 100

    const vars: Record<string, string | number> = {
      '--lg-frost-blur': `${(frostAmt * 0.2).toFixed(2)}px`,
      '--lg-frost-sat': `${(100 + frostAmt * 0.8).toFixed(1)}%`,
      '--lg-light-angle': `${lightAngle}deg`,
      '--lg-light': light.toFixed(3),
      '--lg-glow': glowAmt.toFixed(3),
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

    const radiusStyle: CSSProperties = borderRadiusProp !== undefined ? { borderRadius: borderRadiusProp } : {}
    const tintStyle: CSSProperties = tint !== undefined ? { backgroundColor: tint } : {}

    return {
      ...sizeStyles,
      ...radiusStyle,
      ...tintStyle,
      ...style,
      ...vars,
    } as CSSProperties
  }, [frost, lightAngle, lightIntensity, glow, explicitSize, borderRadiusProp, tint, style])

  const fillLayerStyle = useMemo<CSSProperties | null>(() => {
    const hasFill = fill !== undefined && fill !== false
    const baseFill = fill === true ? FIGMA_MATERIAL_DEFAULTS.fill : typeof fill === 'string' ? fill : undefined
    const overlay =
      fillOverlay === 'none' || fillOverlay === 'transparent'
        ? undefined
        : (fillOverlay ?? (hasFill ? FIGMA_MATERIAL_DEFAULTS.fillOverlay : undefined))
    const resolvedShadow =
      shadow === false || shadow === 'none'
        ? undefined
        : typeof shadow === 'string'
          ? shadow
          : shadow === true || hasFill
            ? FIGMA_MATERIAL_DEFAULTS.shadow
            : undefined

    if (!baseFill && !overlay && !resolvedShadow) return null

    const s: CSSProperties = {}
    if (baseFill) s.backgroundColor = baseFill
    if (overlay) s.backgroundImage = `linear-gradient(${overlay}, ${overlay})`
    if (resolvedShadow) s.boxShadow = resolvedShadow
    return s
  }, [fill, fillOverlay, shadow])

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
      data-lg-light-mode={lightMode}
      className={rootClassName}
      style={rootStyle}
      aria-hidden={isLayer ? 'true' : undefined}
    >
      {targetEl && (
        <div className="lg-refract-clip" aria-hidden="true">
          <canvas ref={canvasRef} className="lg-refract-canvas" />
        </div>
      )}

      {/* Pipeline order: canvas refraction (+ dispersion) first, then frost blur & Figma Fill + Shadow */}
      {frost > 0.05 && <div className="lg-frost" aria-hidden="true" />}
      {fillLayerStyle && <div className="lg-fill" style={fillLayerStyle} aria-hidden="true" />}

      {glow > 0.05 && <div className="lg-glow" aria-hidden="true" />}
      {lightIntensity > 0.05 && <div className="lg-rim" aria-hidden="true" />}

      {hasChildren && <div className="lg-content">{children}</div>}
    </div>
  )
})
