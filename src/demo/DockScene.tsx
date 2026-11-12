import { useCallback, useRef, useState, type ReactNode } from 'react'
import { LiquidGlass, type LiquidGlassProps } from '../glass'

interface AppDef {
  name: string
  from: string
  to: string
  glyph: ReactNode
}

const iconStroke = {
  fill: 'none',
  stroke: '#fff',
  strokeWidth: 2.2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

const APPS: AppDef[] = [
  {
    name: 'Messages',
    from: '#5cf27a',
    to: '#14b83a',
    glyph: (
      <path
        d="M12 5c4.4 0 8 2.9 8 6.5S16.4 18 12 18c-.9 0-1.8-.1-2.6-.4L5.5 19.5l1.1-3.3C5 15 4 13.4 4 11.5 4 7.9 7.6 5 12 5Z"
        fill="#fff"
      />
    ),
  },
  {
    name: 'Safari',
    from: '#4cc3ff',
    to: '#0a62ff',
    glyph: (
      <>
        <circle cx="12" cy="12" r="8" {...iconStroke} />
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
        {[0, 60, 120, 180, 240, 300].map((angle, i) => (
          <ellipse
            key={angle}
            cx="12"
            cy="7.8"
            rx="2.6"
            ry="4"
            fill={['#ff5a5f', '#ffb347', '#ffe36e', '#6ee07a', '#4cb8ff', '#b47cff'][i]}
            opacity=".92"
            transform={`rotate(${angle} 12 12)`}
          />
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
        <rect x="4" y="6.5" width="16" height="11" rx="2.4" {...iconStroke} />
        <path d="m5 8 7 5.2L19 8" {...iconStroke} />
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
    glyph: <path d="M7 8h10M7 12h10M7 16h6" stroke="#6a4a00" strokeWidth="2" strokeLinecap="round" opacity=".75" />,
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

const CHIPS = ['All', 'Photos', 'Albums', 'Shared'] as const

/**
 * Apple iPad Dock / Bottom Bar demo built with the Apple layer hierarchy:
 * Dock -> Frame -> Material [LiquidGlass + Alpha Fill & Shadow] -> App Icons.
 */
export function DockScene({ glass }: { glass: LiquidGlassProps }) {
  const sceneRef = useRef<HTMLDivElement>(null)
  const dockRef = useRef<HTMLDivElement>(null)
  const offset = useRef({ x: 0, y: 0 })
  const drag = useRef<{ id: number; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null)

  const [alphaTinted, setAlphaTinted] = useState(true)
  const [activeChip, setActiveChip] = useState<string>('All')

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    drag.current = {
      id: e.pointerId,
      sx: e.clientX,
      sy: e.clientY,
      ox: offset.current.x,
      oy: offset.current.y,
      moved: false,
    }
  }, [])

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    const dock = dockRef.current
    if (!d || d.id !== e.pointerId || !dock) return
    const dx = e.clientX - d.sx
    const dy = e.clientY - d.sy
    if (!d.moved && Math.hypot(dx, dy) > 5) {
      d.moved = true
      dock.setPointerCapture(e.pointerId)
      dock.dataset.dragging = 'true'
    }
    if (!d.moved) return
    offset.current.x = d.ox + dx
    offset.current.y = d.oy + dy
    dock.style.transform = `translate3d(${offset.current.x}px, ${offset.current.y}px, 0)`
  }, [])

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    drag.current = null
    if (dockRef.current) delete dockRef.current.dataset.dragging
  }, [])

  return (
    <section ref={sceneRef} className="scene" role="region" aria-labelledby="dock-title">
      <div className="scene-wall" />

      <header className="scene-top">
        <div>
          <p className="scene-clock">9:41</p>
          <h2 id="dock-title" className="scene-date">
            Thursday, 12 November · Drag the dock across the cards
          </h2>
        </div>

        <div className="scene-controls" data-lg-ignore="">
          <div className="dock-tint-toggle" role="group" aria-label="Dock Material fill mode">
            <button
              type="button"
              className={'seg' + (alphaTinted ? ' seg--on' : '')}
              onClick={() => setAlphaTinted(true)}
            >
              Alpha Tint
            </button>
            <button
              type="button"
              className={'seg' + (!alphaTinted ? ' seg--on' : '')}
              onClick={() => setAlphaTinted(false)}
            >
              Transparent
            </button>
          </div>

          <nav className="seg-bar" aria-label="Library filter">
            {CHIPS.map((chip) => {
              const selected = activeChip === chip
              return (
                <LiquidGlass
                  key={chip}
                  mode="wrapper"
                  className="seg-chip"
                  refractionTarget={sceneRef}
                  strength={0.07}
                  depth={8}
                  blur={0}
                  chroma={0.6}
                  glow={selected ? 1 : 0.6}
                  edgeHighlight={selected ? 1 : 0.65}
                  specularAngle={glass.specularAngle}
                  specularMode={glass.specularMode}
                >
                  <button
                    type="button"
                    className={'seg-chip-btn' + (selected ? ' seg-chip-btn--on' : '')}
                    aria-pressed={selected}
                    onClick={() => setActiveChip(chip)}
                  >
                    {chip}
                  </button>
                </LiquidGlass>
              )
            })}
          </nav>
        </div>
      </header>

      <div className="scene-cards">
        <article className="card card--text">
          <h3>Refraction, not blur</h3>
          <p>
            Text, borders, and cosmic gradients behind the glass bend physically along the bevel with optional RGB
            chromatic dispersion. Drag the dock over these cards or toggle transparent vs. alpha-tinted fill.
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
          <h3>60–120 fps</h3>
          <p>
            1/4 quadrant SDF bevel LUT + custom <code>&lt;canvas&gt;</code> pixel refractor + pure GPU-composited
            CSS optical rims &amp; volumetric glow.
          </p>
        </article>
      </div>

      <p className="scene-watermark" aria-hidden="true">
        Dock → Frame → Material [LiquidGlass + Fill] → App Icons
      </p>

      {/* Exact Apple layer hierarchy: Dock -> Frame -> Material [LiquidGlass + Alpha Fill & Shadow] -> App Icons */}
      <div
        ref={dockRef}
        data-lg-ignore=""
        className="dock"
        role="toolbar"
        aria-label="iPad Dock (drag to move, click icons to bounce)"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className="dock-frame">
          <div className="dock-material" data-tinted={alphaTinted ? 'true' : 'false'}>
            <LiquidGlass mode="layer" refractionTarget={sceneRef} {...glass} />
          </div>
          <div className="dock-icons">
            {APPS.map((app) => (
              <AppIcon key={app.name} app={app} />
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

