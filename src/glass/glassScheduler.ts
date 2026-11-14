type IntersectionCallback = (isIntersecting: boolean) => void
type ResizeCallback = () => void

let sharedIo: IntersectionObserver | null = null
const ioCallbacks = new WeakMap<Element, Set<IntersectionCallback>>()

function getSharedIo(): IntersectionObserver | null {
  if (typeof IntersectionObserver === 'undefined') return null
  if (!sharedIo) {
    sharedIo = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const cbs = ioCallbacks.get(entry.target)
          if (!cbs) continue
          for (const cb of cbs) {
            cb(entry.isIntersecting)
          }
        }
      },
      { rootMargin: '150px' },
    )
  }
  return sharedIo
}

export function observeGlassIntersection(el: Element, cb: IntersectionCallback): () => void {
  const io = getSharedIo()
  if (!io) return () => {}
  let set = ioCallbacks.get(el)
  if (!set) {
    set = new Set()
    ioCallbacks.set(el, set)
    io.observe(el)
  }
  set.add(cb)
  return () => {
    const cur = ioCallbacks.get(el)
    if (!cur) return
    cur.delete(cb)
    if (cur.size === 0) {
      ioCallbacks.delete(el)
      io.unobserve(el)
    }
  }
}

let sharedRo: ResizeObserver | null = null
const roCallbacks = new WeakMap<Element, Set<ResizeCallback>>()

function getSharedRo(): ResizeObserver | null {
  if (typeof ResizeObserver === 'undefined') return null
  if (!sharedRo) {
    sharedRo = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const cbs = roCallbacks.get(entry.target)
        if (!cbs) continue
        for (const cb of cbs) {
          cb()
        }
      }
    })
  }
  return sharedRo
}

export function observeGlassResize(el: Element, cb: ResizeCallback): () => void {
  const ro = getSharedRo()
  if (!ro) return () => {}
  let set = roCallbacks.get(el)
  if (!set) {
    set = new Set()
    roCallbacks.set(el, set)
    ro.observe(el)
  }
  set.add(cb)
  return () => {
    const cur = roCallbacks.get(el)
    if (!cur) return
    cur.delete(cb)
    if (cur.size === 0) {
      roCallbacks.delete(el)
      ro.unobserve(el)
    }
  }
}

const FRAME_BUDGET_MS = 8
const pendingDraws = new Map<object, () => void>()
let batchRaf = 0

function flushBatch(): void {
  batchRaf = 0
  if (pendingDraws.size === 0) return

  const start = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const iter = pendingDraws.entries()
  let processed = 0

  while (true) {
    const next = iter.next()
    if (next.done) break
    const [key, fn] = next.value
    pendingDraws.delete(key)
    fn()
    processed += 1

    if (processed >= 6 && pendingDraws.size > 0) {
      const elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start
      if (elapsed >= FRAME_BUDGET_MS) {
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
}
