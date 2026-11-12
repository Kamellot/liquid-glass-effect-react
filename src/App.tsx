import { useCallback, useState, useSyncExternalStore } from 'react'
import { detectEngine, getFilterStats, subscribeFilterStats, type GlassEngine } from './glass'
import { ControlPanel } from './demo/ControlPanel'
import { DockScene } from './demo/DockScene'
import { Hero } from './demo/Hero'
import { DEFAULT_PARAMS, type DemoParams } from './demo/presets'

const statsSnapshot = () => {
  const s = getFilterStats()
  return `${s.consumers} glass instances → ${s.filters} <filter>${s.filters === 1 ? '' : 's'}`
}

export default function App() {
  const [params, setParams] = useState<DemoParams>(DEFAULT_PARAMS)
  const [engine, setEngine] = useState<GlassEngine>('auto')
  const [panelOpen, setPanelOpen] = useState(
    () => typeof window !== 'undefined' && !window.matchMedia('(max-width: 860px)').matches
  )
  const stats = useSyncExternalStore(subscribeFilterStats, statsSnapshot, () => '')

  const patch = useCallback((p: Partial<DemoParams>) => setParams((prev) => ({ ...prev, ...p })), [])
  const resolved = engine === 'auto' ? detectEngine() : engine === 'svg' ? 'svg' : 'fallback'

  const { size, ...optics } = params
  // LiquidGlass is memo'd and receives only primitives, so unchanged instances skip rendering.
  const lens = { ...optics, size, engine }
  const dock = { ...optics, engine }

  return (
    <>
      <div className="page">
        <header className="topbar">
          <span className="brand">
            <i className="brand-dot" /> liquid-glass<b>/react</b>
          </span>
          <span className="topbar-note">SDF displacement · SVG backdrop-filter · WebKit bevel fallback</span>
        </header>

        <Hero lens={lens} />
        <DockScene glass={dock} />

        <footer className="foot">
          <p>
            Layer 1 (rim + specular) is pure CSS and runs everywhere. Layer 2 is{' '}
            <code>backdrop-filter: url(#lg-…)</code> where supported, or a masked bevel-ring on Safari / iOS.
          </p>
        </footer>
      </div>

      <ControlPanel
        params={params}
        onChange={patch}
        engine={engine}
        onEngine={setEngine}
        resolvedEngine={resolved}
        stats={stats}
        open={panelOpen}
        onToggle={() => setPanelOpen((o) => !o)}
      />
    </>
  )
}
