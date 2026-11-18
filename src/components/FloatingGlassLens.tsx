import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { clamp, LiquidGlass } from '../glass';

interface FloatingGlassLensProps {
  /** Whole-page container that defines drag bounds and serves as the DOM refraction target. */
  pageRef: RefObject<HTMLElement | null>;
}

const MOBILE_BREAKPOINT = 768;
const DESKTOP_SIZE = 250;
const MOBILE_SIZE = 150;

function getDefaultCenter(width: number, height: number, size: number, isMobile: boolean) {
  const half = size * 0.5;
  if (isMobile) {
    return {
      x: clamp(width * 0.6219, half + 12, Math.max(half + 12, width - half - 12)),
      y: clamp(height * 0.2838, half + 80, Math.max(half + 80, height - half - 32)),
    };
  }
  return {
    x: clamp(width * 0.77315, half + 16, Math.max(half + 16, width - half - 16)),
    y: clamp(height * 0.4379, half + 84, Math.max(half + 84, height - half - 32)),
  };
}

function getBounds(width: number, height: number, size: number) {
  const half = size * 0.5;
  return {
    minX: half,
    maxX: Math.max(half, width - half),
    minY: half,
    maxY: Math.max(half, height - half),
  };
}

function getAutoplayAmplitudes(width: number, height: number, size: number, isMobile: boolean) {
  if (isMobile) {
    return {
      ampX: Math.min(44, Math.max(16, (width - size) * 0.2)),
      ampY: Math.min(46, Math.max(16, (height - size) * 0.075)),
    };
  }
  return {
    ampX: Math.min(78, Math.max(24, (width - size) * 0.075)),
    ampY: Math.min(64, Math.max(22, (height - size) * 0.085)),
  };
}

/**
 * Circular LiquidGlass lens that gently floats with smooth random X/Y autoplay
 * and can be dragged freely across the entire page.
 */
export function FloatingGlassLens({ pageRef }: FloatingGlassLensProps) {
  const handleRef = useRef<HTMLDivElement | null>(null);
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < MOBILE_BREAKPOINT : false,
  );
  const size = isMobile ? MOBILE_SIZE : DESKTOP_SIZE;

  const boxRef = useRef({ width: 1512, height: 902, size: DESKTOP_SIZE, isMobile: false });
  boxRef.current.size = size;
  boxRef.current.isMobile = isMobile;

  const anchorRef = useRef<{ x: number; y: number } | null>(null);
  const posRef = useRef<{ x: number; y: number } | null>(null);
  const velRef = useRef({ x: 0, y: 0 });
  const hasMovedByUserRef = useRef(false);
  const reducedMotionRef = useRef(false);

  const dragRef = useRef<{
    pointerId: number;
    dx: number;
    dy: number;
    lastX: number;
    lastY: number;
    lastAt: number;
    vx: number;
    vy: number;
  } | null>(null);

  const wanderRef = useRef({
    angle: Math.random() * Math.PI * 2,
    dx: 0,
    dy: 0,
    nextChangeAt: 0,
    startTime: 0,
    seeds: [
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2,
    ],
  });

  const applyTransform = useCallback(() => {
    const handle = handleRef.current;
    const pos = posRef.current;
    if (!handle || !pos) return;
    const half = boxRef.current.size * 0.5;
    handle.style.transform = `translate3d(${(pos.x - half).toFixed(2)}px, ${(pos.y - half).toFixed(2)}px, 0)`;
  }, []);

  const evalMicroDrift = useCallback((now: number, ampX: number, ampY: number) => {
    const w = wanderRef.current;
    if (!w.startTime) w.startTime = now;
    const t = (now - w.startTime) * 0.001;
    const [s0, s1, s2, s3] = w.seeds;
    return {
      x: (Math.sin(t * 0.47 + s0) * 0.6 + Math.cos(t * 0.29 + s1) * 0.4) * (ampX * 0.34),
      y: (Math.cos(t * 0.41 + s2) * 0.6 + Math.sin(t * 0.23 + s3) * 0.4) * (ampY * 0.34),
    };
  }, []);

  const pickNextWaypoint = useCallback((now: number, ampX: number, ampY: number) => {
    const w = wanderRef.current;
    const turn = (Math.random() > 0.5 ? 1 : -1) * (0.9 + Math.random() * 1.65);
    w.angle += turn;
    const radiusFrac = 0.45 + Math.random() * 0.55;
    w.dx = Math.cos(w.angle) * ampX * radiusFrac;
    w.dy = Math.sin(w.angle) * ampY * radiusFrac;
    w.nextChangeAt = now + 2200 + Math.random() * 2200;
  }, []);

  const syncPageSize = useCallback(() => {
    const page = pageRef.current;
    if (!page) return false;

    const w = page.clientWidth || window.innerWidth;
    const h = Math.max(page.clientHeight, page.scrollHeight, window.innerHeight);
    const nextMobile = w < MOBILE_BREAKPOINT;
    const nextSize = nextMobile ? MOBILE_SIZE : DESKTOP_SIZE;
    boxRef.current = { width: w, height: h, size: nextSize, isMobile: nextMobile };
    setIsMobile((prev) => (prev === nextMobile ? prev : nextMobile));

    const bounds = getBounds(w, h, nextSize);
    if (!posRef.current || !anchorRef.current || !hasMovedByUserRef.current) {
      const home = getDefaultCenter(w, h, nextSize, nextMobile);
      anchorRef.current = { ...home };
      if (!posRef.current) {
        posRef.current = { ...home };
      } else {
        posRef.current.x = clamp(posRef.current.x, bounds.minX, bounds.maxX);
        posRef.current.y = clamp(posRef.current.y, bounds.minY, bounds.maxY);
      }
    } else {
      anchorRef.current.x = clamp(anchorRef.current.x, bounds.minX, bounds.maxX);
      anchorRef.current.y = clamp(anchorRef.current.y, bounds.minY, bounds.maxY);
      posRef.current.x = clamp(posRef.current.x, bounds.minX, bounds.maxX);
      posRef.current.y = clamp(posRef.current.y, bounds.minY, bounds.maxY);
    }
    applyTransform();
    return true;
  }, [applyTransform, pageRef]);

  useLayoutEffect(() => {
    syncPageSize();
  }, [syncPageSize]);

  useEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    syncPageSize();
    const ro = new ResizeObserver(syncPageSize);
    ro.observe(page);
    return () => ro.disconnect();
  }, [pageRef, syncPageSize]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    reducedMotionRef.current = mql?.matches ?? false;
    const onMotionChange = (e: MediaQueryListEvent) => {
      reducedMotionRef.current = e.matches;
    };
    mql?.addEventListener('change', onMotionChange);

    let rafId = 0;
    let lastNow = 0;

    const tick = (now: number) => {
      rafId = requestAnimationFrame(tick);
      if (document.hidden || dragRef.current || !posRef.current || !anchorRef.current) {
        lastNow = now;
        return;
      }

      const dt = lastNow ? clamp((now - lastNow) / 1000, 0.001, 0.05) : 1 / 60;
      lastNow = now;

      const { width, height, size: curSize, isMobile: mobile } = boxRef.current;
      const bounds = getBounds(width, height, curSize);
      const anchor = anchorRef.current;
      const pos = posRef.current;
      const vel = velRef.current;

      let tx = anchor.x;
      let ty = anchor.y;

      if (!reducedMotionRef.current) {
        const { ampX, ampY } = getAutoplayAmplitudes(width, height, curSize, mobile);
        const w = wanderRef.current;
        if (!w.nextChangeAt || now >= w.nextChangeAt) {
          pickNextWaypoint(now, ampX, ampY);
        }
        const micro = evalMicroDrift(now, ampX, ampY);
        tx = anchor.x + w.dx + micro.x;
        ty = anchor.y + w.dy + micro.y;

        // Before the user manually drags, keep gentle autoplay clear of header/headline edges on short screens.
        if (!hasMovedByUserRef.current) {
          const safeMinY = Math.min(bounds.maxY, curSize * 0.5 + 78);
          ty = Math.max(ty, safeMinY);
        }
      }

      tx = clamp(tx, bounds.minX, bounds.maxX);
      ty = clamp(ty, bounds.minY, bounds.maxY);

      if (reducedMotionRef.current) {
        const speedSq = vel.x * vel.x + vel.y * vel.y;
        const distSq = (tx - pos.x) * (tx - pos.x) + (ty - pos.y) * (ty - pos.y);
        if (speedSq < 0.1 && distSq < 0.25) {
          pos.x = tx;
          pos.y = ty;
          vel.x = 0;
          vel.y = 0;
          return;
        }
      }

      // Critically damped spring steers smoothly toward the random drift target.
      const omega = 1.15;
      const k = omega * omega;
      const c = 2 * omega;
      vel.x += (k * (tx - pos.x) - c * vel.x) * dt;
      vel.y += (k * (ty - pos.y) - c * vel.y) * dt;

      let nx = pos.x + vel.x * dt;
      let ny = pos.y + vel.y * dt;

      if (nx < bounds.minX) {
        nx = bounds.minX;
        if (vel.x < 0) vel.x = 0;
      } else if (nx > bounds.maxX) {
        nx = bounds.maxX;
        if (vel.x > 0) vel.x = 0;
      }
      if (ny < bounds.minY) {
        ny = bounds.minY;
        if (vel.y < 0) vel.y = 0;
      } else if (ny > bounds.maxY) {
        ny = bounds.maxY;
        if (vel.y > 0) vel.y = 0;
      }

      pos.x = nx;
      pos.y = ny;
      applyTransform();
    };

    const onVisibility = () => {
      lastNow = 0;
    };
    document.addEventListener('visibilitychange', onVisibility);
    rafId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafId);
      document.removeEventListener('visibilitychange', onVisibility);
      mql?.removeEventListener('change', onMotionChange);
    };
  }, [applyTransform, evalMicroDrift, pickNextWaypoint]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const page = pageRef.current;
    const pos = posRef.current;
    if (!page || !pos || e.button > 0) return;

    e.currentTarget.setPointerCapture(e.pointerId);
    const pageRect = page.getBoundingClientRect();
    const localX = e.clientX - pageRect.left;
    const localY = e.clientY - pageRect.top;

    hasMovedByUserRef.current = true;
    velRef.current = { x: 0, y: 0 };
    dragRef.current = {
      pointerId: e.pointerId,
      dx: pos.x - localX,
      dy: pos.y - localY,
      lastX: pos.x,
      lastY: pos.y,
      lastAt: performance.now(),
      vx: 0,
      vy: 0,
    };
    e.currentTarget.dataset.dragging = 'true';
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const page = pageRef.current;
    const pos = posRef.current;
    if (!drag || drag.pointerId !== e.pointerId || !page || !pos) return;

    const pageRect = page.getBoundingClientRect();
    const { width, height, size: curSize } = boxRef.current;
    const bounds = getBounds(width, height, curSize);
    const nx = clamp(e.clientX - pageRect.left + drag.dx, bounds.minX, bounds.maxX);
    const ny = clamp(e.clientY - pageRect.top + drag.dy, bounds.minY, bounds.maxY);

    const now = performance.now();
    const dt = (now - drag.lastAt) / 1000;
    if (dt > 0.002 && dt < 0.12) {
      const ivx = clamp((nx - drag.lastX) / dt, -520, 520);
      const ivy = clamp((ny - drag.lastY) / dt, -520, 520);
      drag.vx = drag.vx * 0.45 + ivx * 0.55;
      drag.vy = drag.vy * 0.45 + ivy * 0.55;
    }
    drag.lastX = nx;
    drag.lastY = ny;
    drag.lastAt = now;

    pos.x = nx;
    pos.y = ny;
    applyTransform();
  };

  const finishDrag = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    delete e.currentTarget.dataset.dragging;

    const pos = posRef.current;
    if (!pos) return;
    const now = performance.now();
    const freshRelease = now - drag.lastAt < 80;
    const vx = freshRelease ? drag.vx * 0.55 : 0;
    const vy = freshRelease ? drag.vy * 0.55 : 0;
    velRef.current = { x: vx, y: vy };

    const { width, height, size: curSize, isMobile: mobile } = boxRef.current;
    const bounds = getBounds(width, height, curSize);
    const { ampX, ampY } = getAutoplayAmplitudes(width, height, curSize, mobile);
    const micro = reducedMotionRef.current ? { x: 0, y: 0 } : evalMicroDrift(now, ampX, ampY);

    // Anchor around the release spot (compensating current micro-drift so there is no snap-back).
    anchorRef.current = {
      x: clamp(pos.x + vx * 0.16 - micro.x, bounds.minX, bounds.maxX),
      y: clamp(pos.y + vy * 0.16 - micro.y, bounds.minY, bounds.maxY),
    };
    wanderRef.current.dx = 0;
    wanderRef.current.dy = 0;
    wanderRef.current.nextChangeAt = now + 1800 + Math.random() * 1400;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 44 : 16;
    const deltas: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const delta = deltas[e.key];
    if (!delta || !posRef.current || !anchorRef.current) return;

    e.preventDefault();
    hasMovedByUserRef.current = true;
    const { width, height, size: curSize } = boxRef.current;
    const bounds = getBounds(width, height, curSize);

    posRef.current.x = clamp(posRef.current.x + delta[0], bounds.minX, bounds.maxX);
    posRef.current.y = clamp(posRef.current.y + delta[1], bounds.minY, bounds.maxY);
    anchorRef.current.x = clamp(anchorRef.current.x + delta[0], bounds.minX, bounds.maxX);
    anchorRef.current.y = clamp(anchorRef.current.y + delta[1], bounds.minY, bounds.maxY);
    velRef.current = { x: 0, y: 0 };
    applyTransform();
  };

  return (
    <div
      ref={handleRef}
      data-lg-ignore=""
      className="hero-glass-handle"
      style={{ width: size, height: size }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onKeyDown={onKeyDown}
      tabIndex={0}
      role="application"
      aria-roledescription="Draggable liquid glass lens"
      aria-label="Interactive liquid glass sphere. Drag anywhere on the page or use arrow keys to move."
    >
      <LiquidGlass
        mode="wrapper"
        refractionTarget={pageRef}
        size={size}
        borderRadius={999}
        refraction={68}
        depth={isMobile ? 28 : 42}
        dispersion={18}
        frost={1.5}
        splay={26}
        magnification={1}
        lightMode="natural"
        lightIntensity={48}
        glow={30}
        tint="rgba(255, 255, 255, 0.03)"
        shadow="0 8px 24px rgba(0, 0, 0, 0.24), 0 0 0 0.5px rgba(204, 204, 204, 0.36), -1.25px 0 0 -0.75px rgba(208, 208, 208, 0.52), 1.25px 0 0 -0.75px rgba(208, 208, 208, 0.52)"
      />
    </div>
  );
}
