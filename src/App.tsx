import { useCallback, useState, useSyncExternalStore } from 'react'
import { getFilterStats, subscribeFilterStats, type FilterStats } from './glass'
import { ControlPanel } from './demo/ControlPanel'
import { DockScene } from './demo/DockScene'
import { Hero } from './demo/Hero'
import { DEFAULT_PARAMS, type DemoParams } from './demo/presets'

const SERVER_STATS: FilterStats = { filters: 0, consumers: 0, bitmaps: 0 }

export default function App() {
  const [params, setParams] = useState<DemoParams>(DEFAULT_PARAMS)
  const [panelOpen, setPanelOpen] = useState(
    () => typeof window !== 'undefined' && !window.matchMedia('(max-width: 860px)').matches,
  )

  const filterStats = useSyncExternalStore(subscribeFilterStats, getFilterStats, () => SERVER_STATS)

  const patch = useCallback(
    (next: Partial<DemoParams>) => setParams((prev) => ({ ...prev, ...next })),
    [],
  )

  const statsLabel =
    filterStats.consumers > 0
      ? `${filterStats.consumers} glass instances → ${filterStats.filters} <filter>${filterStats.filters === 1 ? '' : 's'} · ${filterStats.bitmaps} bitmap${filterStats.bitmaps === 1 ? '' : 's'}`
      : 'CSS optical layer'

  const { size, ...optics } = params
  const lens = { ...optics, size }

  return (
    <>
      <div className="page">
        <header className="topbar">
          <span className="brand">
            <i className="brand-dot" /> liquid-glass<b>/react</b>
          </span>
          <span className="topbar-note">
            1/4 Quadrant SDF · Universal SVG Displacement + Pure CSS Optics
          </span>
        </header>

        <Hero lens={lens} />
        <DockScene glass={optics} />

        <footer className="foot">
          <p>
            Hybrid split architecture: <code>refractionEngine.ts</code> computes a 1/4-symmetrical R/G SDF displacement
            map fed into deduplicated <code>&lt;filter&gt;</code> nodes (with Safari cache revisioning and{' '}
            <code>filter: url(#svg)</code> cross-browser target support), while blur, 1.5px conic specular rim, and
            volumetric glow run in GPU-composited CSS.
          </p>
        </footer>
      </div>

      <ControlPanel
        params={params}
        onChange={patch}
        stats={statsLabel}
        open={panelOpen}
        onToggle={() => setPanelOpen((o) => !o)}
      />
    </>
  )
}
