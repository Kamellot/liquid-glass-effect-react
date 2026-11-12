import { useCallback, useRef, useState, type ReactNode } from 'react'
import { GlassScene, LiquidGlass, type LiquidGlassProps } from '../glass'

/* ── App icons ─────────────────────────────────────────────────────────────── */

interface AppDef {
  name: string
  from: string
  to: string
  glyph: ReactNode
}

const stroke = { fill: 'none', stroke: '#fff', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

const APPS: AppDef[] = [
  {
    name: 'Messages',
    from: '#5cf27a',
    to: '#14b83a',
    glyph: <path d="M12 5c4.4 0 8 2.9 8 6.5S16.4 18 12 18c-.9 0-1.8-.1-2.6-.4L5.5 19.5l1.1-3.3C5 15 4 13.4 4 11.5 4 7.9 7.6 5 12 5Z" fill="#fff" />,
  },
  {
    name: 'Safari',
    from: '#4cc3ff',
    to: '#0a62ff',
    glyph: (
      <>
        <circle cx="12" cy="12" r="8" {...stroke} />
        <path d="m15.5 8.5-2 5-5 2 2-5Z" fill="#fff" />
      </>
    ),
  },
  {
    name: 'Music',
    from: '#ff6a88',
    to: '#fa2d48',
    glyph: <path d="M16 5v9.2a2.6 2.6 0 1 1-1.6-2.4V7.6l-5 1.2v7.4a2.6 2.6 0 1 1-1.6-2.4V7.3Z" fill="#fff" />,
  },
  {
    name: 'Photos',
    from: '#ffd36b',
    to: '#ff7a3d',
    glyph: (
      <>
        {[0, 60, 120, 180, 240, 300].map((a, i) => (
          <ellipse key={a} cx="12" cy="7.8" rx="2.6" ry="4" fill={['#ff5a5f', '#ffb347', '#ffe36e', '#6ee07a', '#4cb8ff', '#b47cff'][i]} opacity=".92" transform={`rotate(${a} 12 12)`} />
        ))}
      </>
    ),
  },
  {
    name: 'Mail',
    from: '#56b8ff',
    to: '#1a6bff',
    glyph: (
      <>
        <rect x="4" y="6.5" width="16" height="11" rx="2.4" {...stroke} />
        <path d="m5 8 7 5.2L19 8" {...stroke} />
      </>
    ),
  },
  {
    name: 'Calendar',
    from: '#ffffff',
    to: '#dfe3ea',
    glyph: (
      <>
        <text x="12" y="9" textAnchor="middle" fontSize="4.6" fontWeight="700" fill="#ff3b30" letterSpacing=".4">
          THU
        </text>
        <text x="12" y="18.2" textAnchor="middle" fontSize="10.5" fontWeight="500" fill="#16181d">
          12
        </text>
      </>
    ),
  },
  {
    name: 'Notes',
    from: '#ffe66d',
    to: '#ffbf1f',
    glyph: (
      <>
        <path d="M7 8h10M7 12h10M7 16h6" stroke="#6a4a00" strokeWidth="2" strokeLinecap="round" opacity=".75" />
      </>
    ),
  },
]

function AppIcon({ app }: { app: AppDef }) {
  const [bounce, setBounce] = useState(0)
  return (
    <button
      type="button"
      className="app-icon"
      key={bounce}
      data-bounce={bounce ? 'true' : undefined}
      aria-label={app.name}
      onClick={() => setBounce((b) => b + 1)}
    >
      <span className="app-icon-art" style={{ background: `linear-gradient(160deg, ${app.from}, ${app.to})` }}>
        <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">
          {app.glyph}
        </svg>
      </span>
      <span className="app-icon-tip">{app.name}</span>
    </button>
  )
}

/* ── Scene ──────────────────────────────────────────────────────────────────── */

const CHIPS = ['All', 'Photos', 'Albums', 'Shared']

/**
 * iPad-style dock over a busy wallpaper. The dock is a normal element with its own
 * alpha fill + shadow; <LiquidGlass /> is dropped in as an aria-hidden "Material"
 * child so the app icons stay interactive on top. You can also drag the dock across
 * the cards to see live refraction across text and borders.
 */
export function DockScene({ glass }: { glass: LiquidGlassProps }) {
  const dockRef = useRef<HTMLDivElement>(null)
  const offset = useRef({ x: 0, y: 0 })
  const drag = useRef<{ id: number; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null)

  const onDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    drag.current = {
      id: e.pointerId,
      sx: e.clientX,
      sy: e.clientY,
      ox: offset.current.x,
      oy: offset.current.y,
      moved: false,
    }
  }, [])

  const onMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    const el = dockRef.current
    if (!d || d.id !== e.pointerId || !el) return
    const dx = e.clientX - d.sx
    const dy = e.clientY - d.sy
    if (!d.moved && Math.hypot(dx, dy) > 5) {
      d.moved = true
      el.setPointerCapture(e.pointerId)
      el.dataset.dragging = 'true'
    }
    if (!d.moved) return
    offset.current.x = d.ox + dx
    offset.current.y = d.oy + dy
    el.style.transform = `translate3d(${offset.current.x}px, ${offset.current.y}px, 0)`
  }, [])

  const onUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    drag.current = null
    if (dockRef.current) delete dockRef.current.dataset.dragging
  }, [])

  return (
      <GlassScene className="scene" role="region" aria-labelledby="dock-title">
        <div className="scene-wall" />

        <header className="scene-top">
          <div>
            <p className="scene-clock">9:41</p>
            <h2 id="dock-title" className="scene-date">
              Thursday, 12 November · Drag the dock across the cards
            </h2>
          </div>

            {/* 4 identical wrapper-mode chips → they hash equal and share ONE <filter> / 1 WebGL context. */}
            <nav className="seg-bar" data-glass-ignore="" aria-label="Library filter">
              {CHIPS.map((c, i) => (
                  <LiquidGlass
                    key={c}
                    mode="wrapper"
                    className="seg-chip"
                    engine={glass.engine}
                    strength={0.07}
                    depth={8}
                    blur={0}
                    chroma={0.6}
                    glow={0.6}
                    {...(i === 0 ? { glow: 1 } : null)}
                  >
                    <button type="button" className="seg-chip-btn">
                      {c}
                    </button>
                  </LiquidGlass>
          ))}
                </nav>
      </header>

            <div className="scene-cards">
              <article className="card card--text">
                <h3>Refraction, not blur</h3>
                <p>
                  Text, borders and photos behind the glass are physically bent along the bevel, with chromatic dispersion at the rim.
                  Drag the dock over these letters or adjust the sliders to watch them warp.
                </p>
              </article>
              <article className="card card--art">
                <span className="card-badge">Now playing</span>
                <strong>Aurora Borealis</strong>
                <span>Hypnotic Drift · 3:42</span>
                <div className="eq" aria-hidden="true">
                  {Array.from({ length: 22 }, (_, i) => (
                    <i key={i} style={{ animationDelay: `${(i * 97) % 900}ms` }} />
                  ))}
                </div>
              </article>
              <article className="card card--text card--stats">
                <h3>60 fps</h3>
                <p>Shared WebGL shader on Safari &amp; iOS · Shared SVG filter on Chromium — zero per-frame DOM scraping.</p>
              </article>
            </div>

            <p className="scene-watermark" aria-hidden="true">
              Apple Material Layer · Real-Time Bevel Refraction
            </p>

            {/* Dock: existing "Fill + Shadow" lives on the parent; Material goes inside. */}
              <div
                ref={dockRef}
                data-glass-ignore=""
                className="dock"
                role="toolbar"
                aria-label="Dock (drag to move, click icons to bounce)"
                onPointerDown={onDown}
                onPointerMove={onMove}
                onPointerUp={onUp}
                onPointerCancel={onUp}
              >
                <LiquidGlass {...glass} />
                <div className="dock-icons">
                  {APPS.map((a) => (
                    <AppIcon key={a.name} app={a} />
                  ))}
                </div>
              </div>
          </GlassScene>
          )
}
