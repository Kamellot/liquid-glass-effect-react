import {
  createContext,
  forwardRef,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type MutableRefObject,
} from 'react'
import {
  acquireBevelField,
  chooseRenderScale,
  clamp,
  DEFAULT_GLASS_CONFIG,
  degToRad,
  generateDisplacementMap,
  isTransparentColor,
  isWebGLRefractionAvailable,
  measureElementBox,
  notifyGlassRedrawn,
  nowMs,
  OPTICAL_MATERIAL_DEFAULTS,
  REDUCED_MOTION_DISPLACEMENT_SCALE,
  releaseBevelField,
  renderRefractedBevel,
  resolveTarget,
  subscribeTargetSnapshot,
  getTargetSnapshot,
} from './engine'
import type {
  BevelField,
  DisplacementMapInfo,
  DisplacementMapSpec,
  LiquidGlassGlobalConfig,
  LiquidGlassMode,
  LiquidGlassProps,
  LiquidGlassProviderProps,
} from './types'
import './LiquidGlass.css'

// ── Global configuration store & optional Context provider ───────────────────

let globalStoreConfig: LiquidGlassGlobalConfig | undefined
const configListeners = new Set<() => void>()
const subscribeConfig = (fn: () => void) => {
  configListeners.add(fn)
  return () => {
    configListeners.delete(fn)
  }
}
const getConfigSnapshot = () => globalStoreConfig

export function configureLiquidGlass(config: LiquidGlassGlobalConfig, options?: { replace?: boolean }): void {
  globalStoreConfig = options?.replace ? { ...config } : { ...globalStoreConfig, ...config }
  configListeners.forEach((fn) => fn())
}

export function resetLiquidGlassConfig(): void {
  globalStoreConfig = undefined
  configListeners.forEach((fn) => fn())
}

export const getLiquidGlassConfig = (): LiquidGlassGlobalConfig | undefined => globalStoreConfig

const LiquidGlassContext = createContext<LiquidGlassGlobalConfig | undefined>(undefined)

export function LiquidGlassProvider({ value, config, inherit = true, children }: LiquidGlassProviderProps) {
  const parent = useContext(LiquidGlassContext)
  const local = value ?? config
  const merged = useMemo(
    () => (!inherit || !parent ? local : !local ? parent : { ...parent, ...local }),
    [inherit, parent, local],
  )
  return <LiquidGlassContext.Provider value={merged}>{children}</LiquidGlassContext.Provider>
}

export function useLiquidGlassConfig(): LiquidGlassGlobalConfig | undefined {
  const store = useSyncExternalStore(subscribeConfig, getConfigSnapshot, getConfigSnapshot)
  const ctx = useContext(LiquidGlassContext)
  return useMemo(() => (!store && !ctx ? undefined : !store ? ctx : !ctx ? store : { ...store, ...ctx }), [store, ctx])
}

// ── Shared observers & frame-budgeted draw batcher ───────────────────────────

function createSharedObserver<T>(
  factory: (cbs: WeakMap<Element, Set<T>>) => { observe: (el: Element) => void; unobserve: (el: Element) => void } | null,
) {
  const cbs = new WeakMap<Element, Set<T>>()
  let obs: { observe: (el: Element) => void; unobserve: (el: Element) => void } | null = null
  return (el: Element, cb: T) => {
    if (!obs) obs = factory(cbs)
    if (!obs) return () => {}
    let set = cbs.get(el)
    if (!set) {
      set = new Set()
      cbs.set(el, set)
      obs.observe(el)
    }
    set.add(cb)
    return () => {
      const cur = cbs.get(el)
      if (!cur) return
      cur.delete(cb)
      if (!cur.size) {
        cbs.delete(el)
        obs?.unobserve(el)
      }
    }
  }
}

const observeIntersection = createSharedObserver<(isIntersecting: boolean) => void>((cbs) =>
  typeof IntersectionObserver === 'undefined'
    ? null
    : new IntersectionObserver(
        (entries) => {
          for (const e of entries) cbs.get(e.target)?.forEach((cb) => cb(e.isIntersecting))
        },
        { rootMargin: '150px' },
      ),
)

const observeResize = createSharedObserver<() => void>((cbs) =>
  typeof ResizeObserver === 'undefined'
    ? null
    : new ResizeObserver((entries) => {
        for (const e of entries) cbs.get(e.target)?.forEach((cb) => cb())
      }),
)

const pendingDraws = new Map<object, () => void>()
let batchRaf = 0

function flushBatch(): void {
  batchRaf = 0
  if (!pendingDraws.size) return
  const start = nowMs()
  let processed = 0
  for (const [key, fn] of pendingDraws) {
    pendingDraws.delete(key)
    fn()
    if (++processed >= 4 && pendingDraws.size && nowMs() - start >= 5) {
      batchRaf = requestAnimationFrame(flushBatch)
      return
    }
  }
}

function scheduleDraw(key: object, fn: () => void): void {
  pendingDraws.set(key, fn)
  if (!batchRaf && typeof requestAnimationFrame !== 'undefined') batchRaf = requestAnimationFrame(flushBatch)
}

function cancelDraw(key: object): void {
  pendingDraws.delete(key)
  if (!pendingDraws.size && batchRaf && typeof cancelAnimationFrame !== 'undefined') {
    cancelAnimationFrame(batchRaf)
    batchRaf = 0
  }
}

type RuntimeState = {
  field: BevelField | null
  outImg: ImageData | null
  tint: string
  visible: boolean
  last: LastDraw | null
  reduced: boolean
  refraction: number
  dispersion: number
  frost: number
  onMapUpdate: LiquidGlassProps['onMapUpdate']
}

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

type LastDraw = {
  version: number
  offsetX: number
  offsetY: number
  refraction: number
  dispersion: number
  frost: number
  tint: string
  fieldHash: string
}

function setOffscreenAttr(root: HTMLElement, offscreen: boolean): void {
  if (offscreen !== root.hasAttribute('data-lg-offscreen')) {
    offscreen ? root.setAttribute('data-lg-offscreen', '1') : root.removeAttribute('data-lg-offscreen')
  }
}

function emitMapUpdate(
  cb: ((info: DisplacementMapInfo) => void) | undefined,
  fieldId: string | null,
  spec: DisplacementMapSpec,
  hash: string,
  precomputedUrl?: string,
): void {
  if (!cb) return
  cb({
    fieldId,
    dataUrl: (precomputedUrl ?? generateDisplacementMap(spec)) || null,
    width: spec.width,
    height: spec.height,
    borderRadius: spec.borderRadius,
    hash,
  })
}

function needsScrollSync(targetEl: HTMLElement, root: HTMLElement): boolean {
  if (!targetEl.contains(root)) return true
  for (let n: HTMLElement | null = root; n && n !== targetEl; n = n.parentElement) {
    const pos = getComputedStyle(n).position
    if (pos === 'fixed' || pos === 'sticky') return true
  }
  return false
}

function resolveSurfaceTint(root: HTMLElement, mode: LiquidGlassMode, tint?: string): string {
  if (tint !== undefined && tint.trim().startsWith('rgb')) return isTransparentColor(tint) ? '' : tint
  const src = tint !== undefined || mode !== 'layer' ? root : root.parentElement
  if (!src) return ''
  const bg = getComputedStyle(src).backgroundColor
  return isTransparentColor(bg) ? '' : bg
}

// ── <LiquidGlass /> ──────────────────────────────────────────────────────────

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
    const g = ignoreGlobal ? undefined : globalConfig

    // Start false so SSR markup and initial client hydration match cleanly.
    const [reducedMotion, setReducedMotion] = useState(false)
    useEffect(() => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
      const mql = window.matchMedia('(prefers-reduced-motion: reduce)')
      setReducedMotion(mql.matches)
      const onChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches)
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    }, [])

    const size = sizeProp ?? g?.size
    const baseRefraction = refractionProp ?? g?.refraction ?? DEFAULT_GLASS_CONFIG.refraction
    const depth = depthProp ?? g?.depth ?? DEFAULT_GLASS_CONFIG.depth
    const baseDispersion = dispersionProp ?? g?.dispersion ?? DEFAULT_GLASS_CONFIG.dispersion
    const frost = frostProp ?? g?.frost ?? DEFAULT_GLASS_CONFIG.frost
    const splay = splayProp ?? g?.splay ?? DEFAULT_GLASS_CONFIG.splay
    const lightMode = lightModeProp ?? g?.lightMode ?? DEFAULT_GLASS_CONFIG.lightMode
    const lightAngle = lightAngleProp ?? g?.lightAngle ?? DEFAULT_GLASS_CONFIG.lightAngle
    const lightIntensity = lightIntensityProp ?? g?.lightIntensity ?? DEFAULT_GLASS_CONFIG.lightIntensity
    const glow = glowProp ?? g?.glow ?? DEFAULT_GLASS_CONFIG.glow
    const borderRadiusProp = borderRadiusPropProp ?? g?.borderRadius
    const tint = tintProp ?? g?.tint
    const fill = fillProp ?? g?.fill
    const fillOverlay = fillOverlayProp ?? g?.fillOverlay
    const shadow = shadowProp ?? g?.shadow

    const motionScale = reducedMotion ? REDUCED_MOTION_DISPLACEMENT_SCALE : 1
    const refraction = baseRefraction * motionScale
    const dispersion = baseDispersion * motionScale

    const rootRef = useRef<HTMLDivElement | null>(null)
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const rtRef = useRef<RuntimeState | null>(null)
    const rt = (rtRef.current ??= {
      field: null,
      outImg: null,
      tint: '',
      visible: true,
      last: null,
      reduced: false,
      refraction: 0,
      dispersion: 0,
      frost: 0,
      onMapUpdate: undefined,
    })
    rt.reduced = reducedMotion
    rt.refraction = refraction
    rt.dispersion = dispersion
    rt.frost = frost
    rt.onMapUpdate = onMapUpdate

    const setRootRef = useCallback(
      (node: HTMLDivElement | null) => {
        rootRef.current = node
        if (typeof forwardedRef === 'function') forwardedRef(node)
        else if (forwardedRef) (forwardedRef as MutableRefObject<HTMLDivElement | null>).current = node
      },
      [forwardedRef],
    )

    const [metrics, setMetrics] = useState({ width: 0, height: 0, borderRadius: 0 })
    const [targetEl, setTargetEl] = useState<HTMLElement | null>(null)
    const hasChildren = children !== undefined && children !== null
    const isStandalone = mode === 'wrapper' && !hasChildren
    const explicitSize = mode === 'wrapper' ? size : undefined

    // RefObject identity is stable when .current mounts after child layout effects; sync on both phases.
    const syncTarget = () => {
      const resolved = resolveTarget(refractionTarget)
      setTargetEl((prev) => (prev === resolved ? prev : resolved))
    }
    useIsomorphicLayoutEffect(syncTarget)
    useEffect(syncTarget)

    useIsomorphicLayoutEffect(() => {
      const el = rootRef.current
      if (!el) return
      const update = () => {
        const next = measureElementBox(el, borderRadiusProp)
        setMetrics((p) =>
          p.width === next.width && p.height === next.height && p.borderRadius === next.borderRadius ? p : next,
        )
      }
      update()
      const unsubEl = observeResize(el, update)
      const unsubParent = el.parentElement ? observeResize(el.parentElement, update) : undefined
      return () => {
        unsubEl()
        unsubParent?.()
      }
    }, [mode, explicitSize, isStandalone, className, style?.borderRadius, borderRadiusProp])

    const drawFrame = useCallback(() => {
      if (!rt.visible) return
      const canvas = canvasRef.current
      const root = rootRef.current
      const field = rt.field
      if (!canvas || !root || !field || !targetEl) return
      const visCheck = (root as HTMLElement & { checkVisibility?: (o: object) => boolean }).checkVisibility
      if (typeof visCheck === 'function' && !visCheck.call(root, { checkOpacity: true, checkVisibilityCSS: true })) {
        return
      }

      const rootRect = root.getBoundingClientRect()
      if (
        typeof window !== 'undefined' &&
        window.innerHeight > 0 &&
        (rootRect.bottom < -200 || rootRect.top > window.innerHeight + 200)
      ) {
        rt.visible = false
        setOffscreenAttr(root, true)
        return
      }
      setOffscreenAttr(root, false)

      const ctx = canvas.getContext('2d')
      if (!ctx) return

      const { refraction: curRef, dispersion: curDisp, frost: curFrost, tint: curTint } = rt
      const webgl = isWebGLRefractionAvailable()
      const snapshot = getTargetSnapshot(targetEl, root)
      const syncSize = () => {
        if (canvas.width !== field.bufWidth) canvas.width = field.bufWidth
        if (canvas.height !== field.bufHeight) canvas.height = field.bufHeight
      }
      if (!snapshot || (curRef <= 0.01 && !(webgl && curFrost > 0.05))) {
        syncSize()
        ctx.clearRect(0, 0, field.bufWidth, field.bufHeight)
        rt.last = null
        notifyGlassRedrawn(targetEl, root)
        return
      }

      const targetRect = targetEl.getBoundingClientRect()
      const offsetX = rootRect.left - targetRect.left
      const offsetY = rootRect.top - targetRect.top
      const effectiveFrost = webgl ? curFrost : 0
      const prev = rt.last
      if (
        prev &&
        prev.version === snapshot.version &&
        Math.abs(prev.offsetX - offsetX) < 0.25 &&
        Math.abs(prev.offsetY - offsetY) < 0.25 &&
        prev.refraction === curRef &&
        prev.dispersion === curDisp &&
        prev.frost === effectiveFrost &&
        prev.tint === curTint &&
        prev.fieldHash === field.hash
      ) {
        return
      }

      syncSize()
      if (!webgl && (!rt.outImg || rt.outImg.width !== field.bufWidth || rt.outImg.height !== field.bufHeight)) {
        rt.outImg = ctx.createImageData(field.bufWidth, field.bufHeight)
      }

      renderRefractedBevel(ctx, rt.outImg, field, snapshot, offsetX, offsetY, curRef, curDisp, curTint, curFrost)
      rt.last = {
        version: snapshot.version,
        offsetX,
        offsetY,
        refraction: curRef,
        dispersion: curDisp,
        frost: effectiveFrost,
        tint: curTint,
        fieldHash: field.hash,
      }
      notifyGlassRedrawn(targetEl, root)
    }, [targetEl, rt])

    useIsomorphicLayoutEffect(() => {
      const { width, height, borderRadius } = metrics
      if (width < 2 || height < 2) {
        rt.field = rt.outImg = null
        return
      }
      if (!targetEl) {
        rt.field = rt.outImg = null
        emitMapUpdate(
          rt.onMapUpdate,
          rt.refraction > 0.01 ? 'css-optics' : null,
          { width, height, borderRadius, depth, splay },
          'no-target',
        )
        return
      }

      const scale = chooseRenderScale(width, height, depth)
      const { field, dataUrl } = acquireBevelField(
        { width, height, borderRadius, depth, splay, scale },
        Boolean(rt.onMapUpdate),
      )
      rt.field = field
      if (rootRef.current) scheduleDraw(rootRef.current, drawFrame)
      emitMapUpdate(
        rt.onMapUpdate,
        rt.refraction > 0.01 && depth > 0.5 ? field.fieldId : null,
        { width, height, borderRadius, depth, splay },
        field.hash,
        dataUrl,
      )

      return () => {
        releaseBevelField(field.hash)
        if (rt.field === field) rt.field = null
        rt.outImg = null
      }
    }, [targetEl, metrics, depth, splay, drawFrame, rt])

    useIsomorphicLayoutEffect(() => {
      if (rootRef.current) scheduleDraw(rootRef.current, drawFrame)
      const field = rt.field
      if (!field || !targetEl) return
      emitMapUpdate(
        rt.onMapUpdate,
        refraction > 0.01 && depth > 0.5 ? field.fieldId : null,
        { width: field.width, height: field.height, borderRadius: field.borderRadius, depth, splay },
        field.hash,
      )
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [refraction, dispersion, frost, drawFrame])

    useIsomorphicLayoutEffect(() => {
      const root = rootRef.current
      if (!root) return
      if (!targetEl) {
        return observeIntersection(root, (vis) => {
          rt.visible = vis
          setOffscreenAttr(root, !vis)
        })
      }

      let animRaf = 0
      let animDeadline = 0
      const syncTint = () => {
        rt.tint = resolveSurfaceTint(root, mode, tint)
      }
      const stopAnim = () => {
        if (animRaf) {
          cancelAnimationFrame(animRaf)
          animRaf = 0
        }
      }
      const tickAnim = () => {
        animRaf = 0
        syncTint()
        drawFrame()
        if (nowMs() < animDeadline) animRaf = requestAnimationFrame(tickAnim)
      }
      const startAnim = () => {
        if (rt.reduced) {
          syncTint()
          scheduleDraw(root, drawFrame)
          return
        }
        animDeadline = nowMs() + 450
        if (!animRaf) animRaf = requestAnimationFrame(tickAnim)
      }
      const finishAnim = () => {
        stopAnim()
        syncTint()
        scheduleDraw(root, drawFrame)
      }
      const reqDraw = () => {
        if (rt.visible) scheduleDraw(root, drawFrame)
      }

      const unsubSnap = subscribeTargetSnapshot(targetEl, reqDraw, root)
      syncTint()
      scheduleDraw(root, drawFrame)

      const unsubIo = observeIntersection(root, (vis) => {
        const was = rt.visible
        rt.visible = vis
        setOffscreenAttr(root, !vis)
        if (vis && !was) {
          syncTint()
          scheduleDraw(root, drawFrame)
        }
      })

      const scrollSync = needsScrollSync(targetEl, root)
      const unsubRo = observeResize(root, reqDraw)
      const parentEl = root.parentElement

      // Draw synchronously inside mutation microtask to avoid trailing during CSS transform drags.
      const mo = new MutationObserver(() => {
        if (tint === undefined && mode === 'layer') syncTint()
        drawFrame()
      })
      mo.observe(root, { attributes: true, attributeFilter: ['style', 'class'] })
      if (parentEl && parentEl !== targetEl && parentEl !== document.documentElement) {
        mo.observe(parentEl, { attributes: true, attributeFilter: ['style', 'class'] })
      }

      const animTargets = parentEl ? [root, parentEl] : [root]
      for (const el of animTargets) {
        el.addEventListener('transitionrun', startAnim)
        el.addEventListener('transitionend', finishAnim)
        el.addEventListener('transitioncancel', finishAnim)
      }
      if (scrollSync) window.addEventListener('scroll', reqDraw, { passive: true, capture: true })
      window.addEventListener('resize', reqDraw, { passive: true })

      return () => {
        cancelDraw(root)
        stopAnim()
        unsubSnap()
        unsubIo()
        unsubRo()
        mo.disconnect()
        for (const el of animTargets) {
          el.removeEventListener('transitionrun', startAnim)
          el.removeEventListener('transitionend', finishAnim)
          el.removeEventListener('transitioncancel', finishAnim)
        }
        if (scrollSync) window.removeEventListener('scroll', reqDraw, true)
        window.removeEventListener('resize', reqDraw)
      }
    }, [targetEl, mode, tint, drawFrame])

    const [rootStyle, fillLayerStyle] = useMemo(() => {
      // Subtract 90deg so lightAngle=0 points down from top edge in CSS clockwise coordinates.
      const rad = degToRad(lightAngle - 90)
      const frostAmt = clamp(frost, 0, 100)
      const s: Record<string, string | number> = {}
      if (explicitSize !== undefined) {
        s.width = s.height = explicitSize
        s.borderRadius = '50%'
      }
      if (borderRadiusProp !== undefined) s.borderRadius = borderRadiusProp as string | number
      if (tint !== undefined) s.backgroundColor = tint
      if (style) Object.assign(s, style)
      s['--lg-frost-blur'] = `${(frostAmt * 0.2).toFixed(2)}px`
      s['--lg-frost-sat'] = `${(100 + frostAmt * 0.8).toFixed(1)}%`
      s['--lg-light-angle'] = `${lightAngle}deg`
      s['--lg-light'] = (clamp(lightIntensity, 0, 100) / 50).toFixed(3)
      s['--lg-glow'] = (clamp(glow, 0, 100) / 100).toFixed(3)
      s['--lg-lx'] = Math.cos(rad).toFixed(4)
      s['--lg-ly'] = Math.sin(rad).toFixed(4)

      const hasFill = fill !== undefined && fill !== false
      const baseFill = fill === true ? OPTICAL_MATERIAL_DEFAULTS.fill : typeof fill === 'string' ? fill : undefined
      const overlay =
        fillOverlay === 'none' || fillOverlay === 'transparent'
          ? undefined
          : (fillOverlay ?? (hasFill ? OPTICAL_MATERIAL_DEFAULTS.fillOverlay : undefined))
      const resShadow =
        shadow === false || shadow === 'none'
          ? undefined
          : typeof shadow === 'string'
            ? shadow
            : shadow === true || hasFill
              ? OPTICAL_MATERIAL_DEFAULTS.shadow
              : undefined

      let fs: CSSProperties | null = null
      if (baseFill || overlay || resShadow) {
        fs = {}
        if (baseFill) fs.backgroundColor = baseFill
        if (overlay) fs.backgroundImage = `linear-gradient(${overlay}, ${overlay})`
        if (resShadow) fs.boxShadow = resShadow
      }
      return [s as CSSProperties, fs]
    }, [frost, lightAngle, lightIntensity, glow, explicitSize, borderRadiusProp, tint, style, fill, fillOverlay, shadow])

    const isLayer = mode === 'layer'
    const rootClassName = [
      'lg-root',
      isLayer ? 'lg-root--layer' : 'lg-root--wrapper',
      isStandalone && 'lg-root--standalone',
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
        {!useWebGLFrost && frost > 0.05 && <div className="lg-frost" aria-hidden="true" />}
        {fillLayerStyle && <div className="lg-fill" style={fillLayerStyle} aria-hidden="true" />}
        {glow > 0.05 && <div className="lg-glow" aria-hidden="true" />}
        {lightIntensity > 0.05 && <div className="lg-rim" aria-hidden="true" />}
        {hasChildren && <div className="lg-content">{children}</div>}
      </div>
    )
  }),
)

LiquidGlass.displayName = 'LiquidGlass'
