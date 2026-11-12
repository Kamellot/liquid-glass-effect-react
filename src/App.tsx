import { useCallback, useState, useSyncExternalStore } from 'react'
import {
  getFilterStats,
  getGLStats,
  resolveEngine,
  subscribeFilterStats,
  subscribeGLStats,
  type GlassEngine,
} from './glass'
import { ControlPanel } from './demo/ControlPanel'
import { DockScene } from './demo/DockScene'
import { Hero } from './demo/Hero'
import { DEFAULT_PARAMS, type DemoParams } from './demo/presets'

function subscribeAllStats(cb: () => void) {
  const u1 = subscribeFilterStats(cb)
  const u2 = subscribeGLStats(cb)
  return () => {
    u1()
    u2()
  }
}

const statsSnapshot = () => {
  const gl = getGLStats()
  if (gl.instances > 0) {
    return `${gl.instances} glass instances → 1 WebGL ctx · ${gl.scenes} scene texture${gl.scenes === 1 ? '' : 's'}`
  }
  const s = getFilterStats()
  if (s.consumers > 0) {
    return `${s.consumers} glass instances → ${s.filters} <filter>${s.filters === 1 ? '' : 's'}`
  }
  return 'CSS bevel-ring fallback'
}

export default function App() {
  const [params, setParams] = useState<DemoParams>(DEFAULT_PARAMS)
  const [engine, setEngine] = useState<GlassEngine>('auto')
  const [panelOpen, setPanelOpen] = useState(
      () => typeof window !== 'undefined' && !window.matchMedia('(max-width: 860px)').matches,
  )
  const stats = useSyncExternalStore(subscribeAllStats, statsSnapshot, () => '')

  const patch = useCallback((p: Partial<DemoParams>) => setParams((prev) => ({ ...prev, ...p })), [])
  const resolved = resolveEngine(engine, true)

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
          <span className="topbar-note">Analytical SDF · SVG backdrop-filter + Shared WebGL shader (Safari &amp; iOS)</span>
        </header>

        <Hero lens={lens} />
        <DockScene glass={dock} />

        <footer className="foot">
          <p>
            Layer 1 (rim + specular) is pure CSS and runs everywhere. Layer 2 uses{' '}
            <code>backdrop-filter: url(#lg-…)</code> on Chromium/Firefox and automatically switches to a shared-context{' '}
            <code>WebGL</code> SDF shader on Safari &amp; iOS.
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
