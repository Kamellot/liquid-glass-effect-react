import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MutableRefObject,
  type Ref,
} from 'react'
import {
  DEFAULT_GLASS_CONFIG,
  FROST_BLUR_SCALE,
  FROST_MIN_THRESHOLD,
  FROST_SATURATION_SCALE,
  GLOW_MIN_THRESHOLD,
  LIGHT_INTENSITY_MIN_THRESHOLD,
  OFFSET_EPSILON_PX,
  OFFSCREEN_MARGIN_PX,
  OPTICAL_MATERIAL_DEFAULTS,
  REDUCED_MOTION_DISPLACEMENT_SCALE,
  REFRACTION_MIN_THRESHOLD,
  TRANSITION_LOOP_DURATION_MS,
} from './constants'
import {
  getTargetSnapshot,
  notifyGlassRedrawn,
  subscribeTargetSnapshot,
} from './domSnapshot'
import {
  cancelGlassDraw,
  observeGlassIntersection,
  observeGlassResize,
  scheduleGlassDraw,
} from './glassScheduler'
import { useLiquidGlassConfig } from './LiquidGlassContext'
import {
  acquireBevelField,
  chooseRenderScale,
  generateDisplacementMap,
  releaseBevelField,
  renderRefractedBevel,
  type BevelField,
  type DisplacementMapSpec,
} from './refractionEngine'
import type {
  DisplacementMapInfo,
  LiquidGlassMode,
  LiquidGlassProps,
} from './types'
import {
  clamp,
  degToRad,
  isTransparentColor,
  measureElementBox,
  nowMs,
  resolveTarget,
  type BoxMetrics,
} from './utils'
import { isWebGLRefractionAvailable } from './webglRefraction'
import './LiquidGlass.css'

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

interface LastDrawState {
  version: number
  offsetX: number
  offsetY: number
  refraction: number
  dispersion: number
  frost: number
  tint: string
  fieldHash: string
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (!ref) return
  if (typeof ref === 'function') {
    ref(value)
    return
  }
  ;(ref as MutableRefObject<T | null>).current = value
}

function usePrefersReducedMotion(): boolean {
  // Always start false so SSR markup and initial client hydration match cleanly.
  const [reduced, setReduced] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(mql.matches)
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return reduced
}

function setOffscreenAttr(root: HTMLElement, offscreen: boolean): void {
  const hasAttr = root.hasAttribute('data-lg-offscreen')
  if (offscreen && !hasAttr) {
    root.setAttribute('data-lg-offscreen', '1')
  } else if (!offscreen && hasAttr) {
    root.removeAttribute('data-lg-offscreen')
  }
}

function emitMapUpdate(
  callback: ((info: DisplacementMapInfo) => void) | undefined,
  fieldId: string | null,
  spec: DisplacementMapSpec,
  hash: string,
  precomputedUrl?: string,
): void {
  if (!callback) return
  const dataUrl = precomputedUrl ?? generateDisplacementMap(spec)
  callback({
    fieldId,
    dataUrl: dataUrl || null,
    width: spec.width,
    height: spec.height,
    borderRadius: spec.borderRadius,
    hash,
  })
}

function resolveFillLayerStyle(
  fill: LiquidGlassProps['fill'],
  fillOverlay: LiquidGlassProps['fillOverlay'],
  shadow: LiquidGlassProps['shadow'],
): CSSProperties | null {
  const hasFill = fill !== undefined && fill !== false
  const baseFill =
    fill === true ? OPTICAL_MATERIAL_DEFAULTS.fill : typeof fill === 'string' ? fill : undefined
  const overlay =
    fillOverlay === 'none' || fillOverlay === 'transparent'
      ? undefined
      : (fillOverlay ?? (hasFill ? OPTICAL_MATERIAL_DEFAULTS.fillOverlay : undefined))
  const resolvedShadow =
    shadow === false || shadow === 'none'
      ? undefined
      : typeof shadow === 'string'
        ? shadow
        : shadow === true || hasFill
          ? OPTICAL_MATERIAL_DEFAULTS.shadow
          : undefined

  if (!baseFill && !overlay && !resolvedShadow) return null

  const layerStyle: CSSProperties = {}
  if (baseFill) layerStyle.backgroundColor = baseFill
  if (overlay) layerStyle.backgroundImage = `linear-gradient(${overlay}, ${overlay})`
  if (resolvedShadow) layerStyle.boxShadow = resolvedShadow
  return layerStyle
}

function buildRootStyle(
  frost: number,
  lightAngle: number,
  lightIntensity: number,
  glow: number,
  explicitSize: number | undefined,
  borderRadiusProp: CSSProperties['borderRadius'],
  tint: string | undefined,
  style: CSSProperties | undefined,
): CSSProperties {
  // lightAngle 0 points straight down from the top edge; subtract 90deg to convert CSS clockwise
  // bearings to standard trigonometric coordinates for the specular rim vector.
  const rad = degToRad(lightAngle - 90)
  const lx = Math.cos(rad)
  const ly = Math.sin(rad)
  const frostAmt = clamp(frost, 0, 100)
  const light = clamp(lightIntensity, 0, 100) / 50
  const glowAmt = clamp(glow, 0, 100) / 100

  const vars: Record<string, string | number> = {
    '--lg-frost-blur': `${(frostAmt * FROST_BLUR_SCALE).toFixed(2)}px`,
    '--lg-frost-sat': `${(100 + frostAmt * FROST_SATURATION_SCALE).toFixed(1)}%`,
    '--lg-light-angle': `${lightAngle}deg`,
    '--lg-light': light.toFixed(3),
    '--lg-glow': glowAmt.toFixed(3),
    '--lg-lx': lx.toFixed(4),
    '--lg-ly': ly.toFixed(4),
  }

  return {
    ...(explicitSize !== undefined
      ? { width: explicitSize, height: explicitSize, borderRadius: '50%' }
      : {}),
    ...(borderRadiusProp !== undefined ? { borderRadius: borderRadiusProp } : {}),
    ...(tint !== undefined ? { backgroundColor: tint } : {}),
    ...style,
    ...vars,
  } as CSSProperties
}

function needsScrollSynchronization(targetEl: HTMLElement, root: HTMLElement): boolean {
  if (!targetEl.contains(root)) return true
  let node: HTMLElement | null = root
  while (node && node !== targetEl) {
    const pos = getComputedStyle(node).position
    if (pos === 'fixed' || pos === 'sticky') return true
    node = node.parentElement
  }
  return false
}

function resolveSurfaceTint(root: HTMLElement, mode: LiquidGlassMode, tint?: string): string {
  if (tint !== undefined && tint.trim().startsWith('rgb')) {
    return isTransparentColor(tint) ? '' : tint
  }
  const source = tint !== undefined || mode !== 'layer' ? root : root.parentElement
  if (!source) return ''
  const bg = getComputedStyle(source).backgroundColor
  return isTransparentColor(bg) ? '' : bg
}

function isElementVisibleForDraw(root: HTMLElement): boolean {
  const candidate = root as HTMLElement & {
    checkVisibility?: (opts?: { checkOpacity?: boolean; checkVisibilityCSS?: boolean }) => boolean
  }
  if (typeof candidate.checkVisibility === 'function') {
    return candidate.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
  }
  return true
}

export const LiquidGlass = memo(
  forwardRef<HTMLDivElement, LiquidGlassProps>(function LiquidGlass(
    {
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
      'aria-hidden': ariaHiddenProp,
      ...restProps
    },
    forwardedRef,
  ) {
    const globalConfig = useLiquidGlassConfig()
    const activeGlobal = ignoreGlobal ? undefined : globalConfig
    const prefersReducedMotion = usePrefersReducedMotion()

    const size = sizeProp ?? activeGlobal?.size
    const baseRefraction = refractionProp ?? activeGlobal?.refraction ?? DEFAULT_GLASS_CONFIG.refraction
    const depth = depthProp ?? activeGlobal?.depth ?? DEFAULT_GLASS_CONFIG.depth
    const baseDispersion = dispersionProp ?? activeGlobal?.dispersion ?? DEFAULT_GLASS_CONFIG.dispersion
    const frost = frostProp ?? activeGlobal?.frost ?? DEFAULT_GLASS_CONFIG.frost
    const splay = splayProp ?? activeGlobal?.splay ?? DEFAULT_GLASS_CONFIG.splay
    const lightMode = lightModeProp ?? activeGlobal?.lightMode ?? DEFAULT_GLASS_CONFIG.lightMode
    const lightAngle = lightAngleProp ?? activeGlobal?.lightAngle ?? DEFAULT_GLASS_CONFIG.lightAngle
    const lightIntensity =
      lightIntensityProp ?? activeGlobal?.lightIntensity ?? DEFAULT_GLASS_CONFIG.lightIntensity
    const glow = glowProp ?? activeGlobal?.glow ?? DEFAULT_GLASS_CONFIG.glow
    const borderRadiusProp = borderRadiusPropProp ?? activeGlobal?.borderRadius
    const tint = tintProp ?? activeGlobal?.tint
    const fill = fillProp ?? activeGlobal?.fill
    const fillOverlay = fillOverlayProp ?? activeGlobal?.fillOverlay
    const shadow = shadowProp ?? activeGlobal?.shadow

    const refraction = prefersReducedMotion
      ? baseRefraction * REDUCED_MOTION_DISPLACEMENT_SCALE
      : baseRefraction
    const dispersion = prefersReducedMotion
      ? baseDispersion * REDUCED_MOTION_DISPLACEMENT_SCALE
      : baseDispersion

    const rootRef = useRef<HTMLDivElement | null>(null)
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const fieldRef = useRef<BevelField | null>(null)
    const outImageRef = useRef<ImageData | null>(null)
    const parentTintRef = useRef('')
    const isVisibleRef = useRef(true)
    const lastDrawRef = useRef<LastDrawState | null>(null)
    const reducedMotionRef = useRef(prefersReducedMotion)
    reducedMotionRef.current = prefersReducedMotion

    const opticsRef = useRef({ refraction, dispersion, frost })
    opticsRef.current = { refraction, dispersion, frost }

    const onMapUpdateRef = useRef(onMapUpdate)
    onMapUpdateRef.current = onMapUpdate

    const setRootRef = useCallback(
      (node: HTMLDivElement | null) => {
        rootRef.current = node
        assignRef(forwardedRef, node)
      },
      [forwardedRef],
    )

    const [metrics, setMetrics] = useState<BoxMetrics>({ width: 0, height: 0, borderRadius: 0 })
    const [targetEl, setTargetEl] = useState<HTMLElement | null>(null)

    const hasChildren = children !== undefined && children !== null
    const isStandalone = mode === 'wrapper' && !hasChildren
    const explicitSize = mode === 'wrapper' ? size : undefined

    // RefObject identity never changes when .current mounts after child layout effects in React 19,
    // so sync both on layout and commit without a dependency array.
    useIsomorphicLayoutEffect(() => {
      const resolved = resolveTarget(refractionTarget)
      setTargetEl((prev) => (prev === resolved ? prev : resolved))
    })

    useEffect(() => {
      const resolved = resolveTarget(refractionTarget)
      setTargetEl((prev) => (prev === resolved ? prev : resolved))
    })

    useIsomorphicLayoutEffect(() => {
      const el = rootRef.current
      if (!el) return

      const update = () => {
        const next = measureElementBox(el, borderRadiusProp)
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
      if (!canvas || !root || !field || !targetEl || !isElementVisibleForDraw(root)) return

      const rootRect = root.getBoundingClientRect()
      if (
        typeof window !== 'undefined' &&
        window.innerHeight > 0 &&
        (rootRect.bottom < -OFFSCREEN_MARGIN_PX || rootRect.top > window.innerHeight + OFFSCREEN_MARGIN_PX)
      ) {
        isVisibleRef.current = false
        setOffscreenAttr(root, true)
        return
      }
      setOffscreenAttr(root, false)

      const ctx = canvas.getContext('2d')
      if (!ctx) return

      const { refraction: curRefraction, dispersion: curDispersion, frost: curFrost } = opticsRef.current
      const webgl = isWebGLRefractionAvailable()
      const snapshot = getTargetSnapshot(targetEl, root)
      const hasEffect = curRefraction > REFRACTION_MIN_THRESHOLD || (webgl && curFrost > FROST_MIN_THRESHOLD)

      if (!snapshot || !hasEffect) {
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
      const effectiveFrost = webgl ? curFrost : 0

      const prev = lastDrawRef.current
      if (
        prev &&
        prev.version === snapshot.version &&
        Math.abs(prev.offsetX - offsetX) < OFFSET_EPSILON_PX &&
        Math.abs(prev.offsetY - offsetY) < OFFSET_EPSILON_PX &&
        prev.refraction === curRefraction &&
        prev.dispersion === curDispersion &&
        prev.frost === effectiveFrost &&
        prev.tint === parentTintRef.current &&
        prev.fieldHash === field.hash
      ) {
        return
      }

      if (canvas.width !== field.bufWidth) canvas.width = field.bufWidth
      if (canvas.height !== field.bufHeight) canvas.height = field.bufHeight

      if (
        !webgl &&
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
        curFrost,
      )
      lastDrawRef.current = {
        version: snapshot.version,
        offsetX,
        offsetY,
        refraction: curRefraction,
        dispersion: curDispersion,
        frost: effectiveFrost,
        tint: parentTintRef.current,
        fieldHash: field.hash,
      }
      notifyGlassRedrawn(targetEl, root)
    }, [targetEl])

    useIsomorphicLayoutEffect(() => {
      const { width, height, borderRadius } = metrics
      if (width < 2 || height < 2) {
        fieldRef.current = null
        outImageRef.current = null
        return
      }

      if (!targetEl) {
        fieldRef.current = null
        outImageRef.current = null
        emitMapUpdate(
          onMapUpdateRef.current,
          opticsRef.current.refraction > REFRACTION_MIN_THRESHOLD ? 'css-optics' : null,
          { width, height, borderRadius, depth, splay },
          'no-target',
        )
        return
      }

      const scale = chooseRenderScale(width, height, depth)
      const { field, dataUrl } = acquireBevelField(
        { width, height, borderRadius, depth, splay, scale },
        Boolean(onMapUpdateRef.current),
      )

      fieldRef.current = field
      if (rootRef.current) {
        scheduleGlassDraw(rootRef.current, drawFrame)
      }

      emitMapUpdate(
        onMapUpdateRef.current,
        opticsRef.current.refraction > REFRACTION_MIN_THRESHOLD && depth > 0.5 ? field.fieldId : null,
        { width, height, borderRadius, depth, splay },
        field.hash,
        dataUrl,
      )

      return () => {
        releaseBevelField(field.hash)
        if (fieldRef.current === field) {
          fieldRef.current = null
        }
        outImageRef.current = null
      }
    }, [targetEl, metrics, depth, splay, drawFrame])

    useIsomorphicLayoutEffect(() => {
      if (rootRef.current) {
        scheduleGlassDraw(rootRef.current, drawFrame)
      }
      const field = fieldRef.current
      if (!field || !targetEl) return
      emitMapUpdate(
        onMapUpdateRef.current,
        refraction > REFRACTION_MIN_THRESHOLD && depth > 0.5 ? field.fieldId : null,
        {
          width: field.width,
          height: field.height,
          borderRadius: field.borderRadius,
          depth,
          splay,
        },
        field.hash,
      )
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [refraction, dispersion, frost, drawFrame])

    useIsomorphicLayoutEffect(() => {
      const root = rootRef.current
      if (!root) return

      if (!targetEl) {
        return observeGlassIntersection(root, (isIntersecting) => {
          isVisibleRef.current = isIntersecting
          setOffscreenAttr(root, !isIntersecting)
        })
      }

      let animRaf = 0
      let animDeadline = 0

      const syncTint = () => {
        parentTintRef.current = resolveSurfaceTint(root, mode, tint)
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
        if (nowMs() < animDeadline) {
          animRaf = requestAnimationFrame(tickAnim)
        }
      }

      const startAnimLoop = () => {
        if (reducedMotionRef.current) {
          syncTint()
          scheduleGlassDraw(root, drawFrame)
          return
        }
        animDeadline = nowMs() + TRANSITION_LOOP_DURATION_MS
        if (!animRaf) animRaf = requestAnimationFrame(tickAnim)
      }

      const onTransitionFinish = () => {
        stopAnimLoop()
        syncTint()
        scheduleGlassDraw(root, drawFrame)
      }

      const scheduleDraw = () => {
        if (!isVisibleRef.current) return
        scheduleGlassDraw(root, drawFrame)
      }

      const unsubSnapshot = subscribeTargetSnapshot(targetEl, scheduleDraw, root)
      syncTint()
      scheduleGlassDraw(root, drawFrame)

      const unsubIo = observeGlassIntersection(root, (isIntersecting) => {
        const wasVisible = isVisibleRef.current
        isVisibleRef.current = isIntersecting
        setOffscreenAttr(root, !isIntersecting)
        if (isIntersecting && !wasVisible) {
          syncTint()
          scheduleGlassDraw(root, drawFrame)
        }
      })

      const needsScrollSync = needsScrollSynchronization(targetEl, root)
      const unsubRo = observeGlassResize(root, scheduleDraw)

      // Synchronous draw inside mutation microtask prevents trailing during transform drags.
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

      const transitionTargets = [root, parentEl].filter((el): el is HTMLElement => Boolean(el))
      for (const el of transitionTargets) {
        el.addEventListener('transitionrun', startAnimLoop)
        el.addEventListener('transitionend', onTransitionFinish)
        el.addEventListener('transitioncancel', onTransitionFinish)
      }
      if (needsScrollSync) {
        window.addEventListener('scroll', scheduleDraw, { passive: true, capture: true })
      }
      window.addEventListener('resize', scheduleDraw, { passive: true })

      return () => {
        cancelGlassDraw(root)
        stopAnimLoop()
        unsubSnapshot()
        unsubIo()
        unsubRo()
        ancestorMo.disconnect()
        for (const el of transitionTargets) {
          el.removeEventListener('transitionrun', startAnimLoop)
          el.removeEventListener('transitionend', onTransitionFinish)
          el.removeEventListener('transitioncancel', onTransitionFinish)
        }
        if (needsScrollSync) {
          window.removeEventListener('scroll', scheduleDraw, true)
        }
        window.removeEventListener('resize', scheduleDraw)
      }
    }, [targetEl, mode, tint, drawFrame])

    const rootStyle = useMemo(
      () =>
        buildRootStyle(
          frost,
          lightAngle,
          lightIntensity,
          glow,
          explicitSize,
          borderRadiusProp,
          tint,
          style,
        ),
      [frost, lightAngle, lightIntensity, glow, explicitSize, borderRadiusProp, tint, style],
    )

    const fillLayerStyle = useMemo(
      () => resolveFillLayerStyle(fill, fillOverlay, shadow),
      [fill, fillOverlay, shadow],
    )

    const isLayer = mode === 'layer'
    const rootClassName = [
      'lg-root',
      isLayer ? 'lg-root--layer' : 'lg-root--wrapper',
      isStandalone ? 'lg-root--standalone' : '',
      className,
    ]
      .filter(Boolean)
      .join(' ')

    const useWebGLFrost = Boolean(targetEl) && isWebGLRefractionAvailable()

    return (
      <div
        {...restProps}
        ref={setRootRef}
        data-lg-root=""
        data-lg-engine={targetEl ? 'canvas-sdf' : 'css-optics'}
        data-lg-light-mode={lightMode}
        className={rootClassName}
        style={rootStyle}
        aria-hidden={ariaHiddenProp ?? (isLayer ? 'true' : undefined)}
      >
        {targetEl && (
          <div className="lg-refract-clip" aria-hidden="true">
            <canvas ref={canvasRef} className="lg-refract-canvas" />
          </div>
        )}

        {!useWebGLFrost && frost > FROST_MIN_THRESHOLD && <div className="lg-frost" aria-hidden="true" />}
        {fillLayerStyle && <div className="lg-fill" style={fillLayerStyle} aria-hidden="true" />}

        {glow > GLOW_MIN_THRESHOLD && <div className="lg-glow" aria-hidden="true" />}
        {lightIntensity > LIGHT_INTENSITY_MIN_THRESHOLD && <div className="lg-rim" aria-hidden="true" />}

        {hasChildren && <div className="lg-content">{children}</div>}
      </div>
    )
  }),
)

LiquidGlass.displayName = 'LiquidGlass'
