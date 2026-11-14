import { DRAW_BATCH_MIN_OPS, DRAW_FRAME_BUDGET_MS, INTERSECTION_ROOT_MARGIN } from './constants'
import { nowMs } from './utils'

type IntersectionCallback = (isIntersecting: boolean) => void
type ResizeCallback = () => void

function createSharedElementObserver<TCallback>(
  createObserver: (callbacks: WeakMap<Element, Set<TCallback>>) => {
    observe: (el: Element) => void
    unobserve: (el: Element) => void
  } | null,
): (el: Element, cb: TCallback) => () => void {
  const callbacks = new WeakMap<Element, Set<TCallback>>()
  let observer: { observe: (el: Element) => void; unobserve: (el: Element) => void } | null = null

  return (el: Element, cb: TCallback) => {
    if (!observer) {
      observer = createObserver(callbacks)
    }
    if (!observer) return () => {}

    let set = callbacks.get(el)
    if (!set) {
      set = new Set()
      callbacks.set(el, set)
      observer.observe(el)
    }
    set.add(cb)

    return () => {
      const cur = callbacks.get(el)
      if (!cur) return
      cur.delete(cb)
      if (cur.size === 0) {
        callbacks.delete(el)
        observer?.unobserve(el)
      }
    }
  }
}

export const observeGlassIntersection = createSharedElementObserver<IntersectionCallback>((callbacks) => {
  if (typeof IntersectionObserver === 'undefined') return null
  return new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const cbs = callbacks.get(entry.target)
        if (!cbs) continue
        for (const cb of cbs) cb(entry.isIntersecting)
      }
    },
    { rootMargin: INTERSECTION_ROOT_MARGIN },
  )
})

export const observeGlassResize = createSharedElementObserver<ResizeCallback>((callbacks) => {
  if (typeof ResizeObserver === 'undefined') return null
  return new ResizeObserver((entries) => {
    for (const entry of entries) {
      const cbs = callbacks.get(entry.target)
      if (!cbs) continue
      for (const cb of cbs) cb()
    }
  })
})

const pendingDraws = new Map<object, () => void>()
let batchRaf = 0

function flushBatch(): void {
  batchRaf = 0
  if (pendingDraws.size === 0) return

  const start = nowMs()
  const iter = pendingDraws.entries()
  let processed = 0

  while (true) {
    const next = iter.next()
    if (next.done) break
    const [key, fn] = next.value
    pendingDraws.delete(key)
    fn()
    processed += 1

    if (processed >= DRAW_BATCH_MIN_OPS && pendingDraws.size > 0) {
      if (nowMs() - start >= DRAW_FRAME_BUDGET_MS) {
        batchRaf = requestAnimationFrame(flushBatch)
        return
      }
    }
  }
}

export function scheduleGlassDraw(key: object, fn: () => void): void {
  pendingDraws.set(key, fn)
  if (!batchRaf && typeof requestAnimationFrame !== 'undefined') {
    batchRaf = requestAnimationFrame(flushBatch)
  }
}

export function cancelGlassDraw(key: object): void {
  pendingDraws.delete(key)
  if (pendingDraws.size === 0 && batchRaf && typeof cancelAnimationFrame !== 'undefined') {
    cancelAnimationFrame(batchRaf)
    batchRaf = 0
  }
}
