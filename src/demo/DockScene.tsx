import { useCallback, useRef, useState, type ReactNode } from 'react'
import { LiquidGlass, type LiquidGlassProps } from '../glass'
import { LiquidSegmentedControl, LiquidSwitch } from './LiquidControls'

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
    name: 'Browser',
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

interface CardDef {
  id: string
  kind: 'text' | 'art'
  title: string
  searchText: string
}

const CARDS: CardDef[] = [
  {
    id: 'refraction',
    kind: 'text',
    title: 'Refraction, not blur',
    searchText:
      'Refraction, not blur Text borders and cosmic gradients behind the glass bend physically along the bevel with RGB chromatic dispersion transparent alpha tint',
  },
  {
    id: 'music',
    kind: 'art',
    title: 'Aurora Borealis',
    searchText: 'Now playing Aurora Borealis Hypnotic Drift 3:42 music equalizer',
  },
  {
    id: 'perf',
    kind: 'text',
    title: '60–120 fps',
    searchText:
      '60-120 fps 1/4 quadrant SDF bevel LUT custom canvas pixel refractor GPU composited CSS optical rims volumetric glow',
  },
]

const GLASS_TINTS = [
  { id: 'smoke', label: 'Smoke', color: 'rgb(38 42 58 / 0.34)', dot: '#3a4158' },
  { id: 'indigo', label: 'Indigo', color: 'rgb(94 92 230 / 0.28)', dot: '#6c6aff' },
  { id: 'emerald', label: 'Emerald', color: 'rgb(32 168 96 / 0.26)', dot: '#30d158' },
  { id: 'rose', label: 'Rose', color: 'rgb(232 76 122 / 0.26)', dot: '#ff4f87' },
  { id: 'frost', label: 'Frost', color: 'rgb(255 255 255 / 0.16)', dot: '#e5e9f2' },
] as const

/** Shared pointer-drag hook for translating floating showcase surfaces. */
function useDragTranslate(ignoreSelector?: string) {
  const ref = useRef<HTMLDivElement>(null)
  const offset = useRef({ x: 0, y: 0 })
  const drag = useRef<{ id: number; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null)

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (ignoreSelector && e.target instanceof Element && e.target.closest(ignoreSelector)) return
      drag.current = {
        id: e.pointerId,
        sx: e.clientX,
        sy: e.clientY,
        ox: offset.current.x,
        oy: offset.current.y,
        moved: false,
      }
    },
    [ignoreSelector],
  )

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    const el = ref.current
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

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    drag.current = null
    if (ref.current) delete ref.current.dataset.dragging
  }, [])

  return { ref, onPointerDown, onPointerMove, onPointerUp }
}

function AppIcon({ app, dimmed }: { app: AppDef; dimmed?: boolean }) {
  const [bounce, setBounce] = useState(0)
  return (
    <button
      type="button"
      className="app-icon"
      key={bounce}
      data-bounce={bounce ? 'true' : undefined}
      data-dimmed={dimmed ? 'true' : undefined}
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
 * Floating Dock, Glass Switch, and Floating Search showcase built with an Optical Material hierarchy:
 * Container -> Frame -> Material [LiquidGlass + Alpha Fill & Shadow] -> Foreground Content.
 */
export function DockScene({ glass }: { glass: LiquidGlassProps }) {
  const sceneRef = useRef<HTMLDivElement>(null)
  const dockDrag = useDragTranslate()
  const searchDrag = useDragTranslate('input, button')

  const [alphaTinted, setAlphaTinted] = useState(true)
  const [tintId, setTintId] = useState<(typeof GLASS_TINTS)[number]['id']>('smoke')
  const [activeChip, setActiveChip] = useState<(typeof CHIPS)[number]>('All')
  const [searchQuery, setSearchQuery] = useState('')

  const activeTint = GLASS_TINTS.find((t) => t.id === tintId) ?? GLASS_TINTS[0]
  const appliedTint = alphaTinted ? activeTint.color : 'transparent'

  const query = searchQuery.trim().toLowerCase()
  const cardMatches = CARDS.map((c) => !query || c.searchText.toLowerCase().includes(query))
  const appMatches = APPS.map((a) => !query || a.name.toLowerCase().includes(query))
  const matchCount =
    cardMatches.filter(Boolean).length + appMatches.filter(Boolean).length

  return (
    <section ref={sceneRef} className="scene" role="region" aria-labelledby="dock-title">
      <div className="scene-wall" />

      <header className="scene-top">
        <div>
          <p className="scene-clock">9:41</p>
          <h2 id="dock-title" className="scene-date">
            Thursday, 12 November · Drag the dock or search bar across the cards
          </h2>
        </div>

        <div className="scene-controls">
          <div className="scene-tint-bar">
            <div className="tint-swatches" role="group" aria-label="Liquid Glass UI background tint">
              {GLASS_TINTS.map((swatch) => {
                const selected = alphaTinted && tintId === swatch.id
                return (
                  <button
                    key={swatch.id}
                    type="button"
                    className={'tint-swatch' + (selected ? ' tint-swatch--on' : '')}
                    style={{ background: swatch.dot }}
                    aria-label={`${swatch.label} background tint`}
                    aria-pressed={selected}
                    title={`${swatch.label} tint`}
                    onClick={() => {
                      setTintId(swatch.id)
                      setAlphaTinted(true)
                    }}
                  />
                )
              })}
            </div>

            <div className="switch-group">
              <span id="ui-tint-label" className="switch-label">
                UI Tint
              </span>
              <LiquidSwitch
                checked={alphaTinted}
                onChange={setAlphaTinted}
                glass={glass}
                refractionTarget={sceneRef}
                ariaLabelledBy="ui-tint-label"
              />
            </div>
          </div>

          <LiquidSegmentedControl
            options={CHIPS}
            value={activeChip}
            onChange={setActiveChip}
            glass={glass}
            refractionTarget={sceneRef}
            tint={alphaTinted && tintId !== 'smoke' ? activeTint.color : undefined}
            ariaLabel="Library filter"
          />
        </div>
      </header>

      <div className="scene-cards">
        <article className="card card--text" data-dimmed={!cardMatches[0] ? 'true' : undefined}>
          <h3>Refraction, not blur</h3>
          <p>
            Text, borders, and cosmic gradients behind the glass bend physically along the bevel with optional RGB
            chromatic dispersion. Drag the dock or search pill over these cards, or switch tints above.
          </p>
        </article>

        <article className="card card--art" data-dimmed={!cardMatches[1] ? 'true' : undefined}>
          <span className="card-badge">Now playing</span>
          <strong>Aurora Borealis</strong>
          <span>Hypnotic Drift · 3:42</span>
          <div className="eq" aria-hidden="true">
            {Array.from({ length: 22 }, (_, i) => (
              <i key={i} style={{ animationDelay: `${(i * 97) % 900}ms` }} />
            ))}
          </div>
        </article>

        <article className="card card--text card--stats" data-dimmed={!cardMatches[2] ? 'true' : undefined}>
          <h3>60–120 fps</h3>
          <p>
            1/4 quadrant SDF bevel LUT + custom <code>&lt;canvas&gt;</code> pixel refractor + pure GPU-composited
            CSS optical rims &amp; volumetric glow.
          </p>
        </article>
      </div>

      {/* Floating Liquid Glass Search Bar (draggable via pill rim / icon) */}
      <div className="floating-search-slot">
        <div
          ref={searchDrag.ref}
          data-lg-ignore=""
          className="floating-search"
          onPointerDown={searchDrag.onPointerDown}
          onPointerMove={searchDrag.onPointerMove}
          onPointerUp={searchDrag.onPointerUp}
          onPointerCancel={searchDrag.onPointerUp}
        >
          <LiquidGlass
            mode="wrapper"
            className="floating-search-glass"
            refractionTarget={sceneRef}
            tint={alphaTinted ? activeTint.color : undefined}
            refraction={glass.refraction}
            depth={glass.depth}
            splay={glass.splay}
            dispersion={glass.dispersion}
            frost={glass.frost}
            lightAngle={glass.lightAngle}
            lightIntensity={Math.max(glass.lightIntensity ?? 40, 50)}
          >
            <div className="floating-search-inner">
              <svg className="floating-search-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <circle cx="8.75" cy="8.75" r="5.5" stroke="currentColor" strokeWidth="1.8" />
                <path d="M13 13l4.2 4.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
              <input
                type="search"
                className="floating-search-input"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search cards & dock apps… (drag pill)"
                aria-label="Search cards and dock apps"
              />
              {query && (
                <>
                  <span className="floating-search-count" aria-live="polite">
                    {matchCount}
                  </span>
                  <button
                    type="button"
                    className="floating-search-clear"
                    aria-label="Clear search"
                    onClick={() => setSearchQuery('')}
                  >
                    ×
                  </button>
                </>
              )}
            </div>
          </LiquidGlass>
        </div>
      </div>

      <p className="scene-watermark" aria-hidden="true">
        Dock → Frame → Material [LiquidGlass + Fill] → App Icons
      </p>

      {/* Layer hierarchy: Dock -> Frame -> Material [LiquidGlass + Alpha Fill & Shadow] -> App Icons */}
      <div
        ref={dockDrag.ref}
        data-lg-ignore=""
        className="dock"
        role="toolbar"
        aria-label="Floating Dock (drag to move, click icons to bounce)"
        onPointerDown={dockDrag.onPointerDown}
        onPointerMove={dockDrag.onPointerMove}
        onPointerUp={dockDrag.onPointerUp}
        onPointerCancel={dockDrag.onPointerUp}
      >
        <div className="dock-frame">
          <div
            className="dock-material"
            data-tinted={alphaTinted ? 'true' : 'false'}
            style={{ backgroundColor: appliedTint }}
          >
            <LiquidGlass mode="layer" refractionTarget={sceneRef} {...glass} />
          </div>
          <div className="dock-icons">
            {APPS.map((app, i) => (
              <AppIcon key={app.name} app={app} dimmed={!appMatches[i]} />
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

