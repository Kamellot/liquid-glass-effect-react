import { useCallback, useState, useSyncExternalStore } from 'react'
import { getEngineStats, subscribeEngineStats, type EngineStats } from './glass'
import { ControlPanel } from './demo/ControlPanel'
import { BentoTestScene } from './demo/BentoTestScene'
import { DockScene } from './demo/DockScene'
import { Hero } from './demo/Hero'
import { PerfObserverHud } from './demo/PerfObserverHud'
import { StressTestScene } from './demo/StressTestScene'
import { VideoScene } from './demo/VideoScene'
import { DEFAULT_PARAMS, type DemoParams } from './demo/presets'

const SERVER_STATS: EngineStats = { fields: 0, consumers: 0, bitmaps: 0, snapshots: 0 }

export default function App() {
  const [params, setParams] = useState<DemoParams>(DEFAULT_PARAMS)
  const [panelOpen, setPanelOpen] = useState(
    () => typeof window !== 'undefined' && !window.matchMedia('(max-width: 860px)').matches,
  )

  const stats = useSyncExternalStore(subscribeEngineStats, getEngineStats, () => SERVER_STATS)

  const patch = useCallback(
    (next: Partial<DemoParams>) => setParams((prev) => ({ ...prev, ...next })),
    [],
  )

  const statsLabel =
    stats.consumers > 0
      ? `${stats.consumers} glass instances → ${stats.fields} bevel field${stats.fields === 1 ? '' : 's'} · ${stats.snapshots} snapshot${stats.snapshots === 1 ? '' : 's'}`
      : 'CSS optical layer'

  const { size, ...optics } = params
  const lens = { ...optics, size }
  const dock = { ...optics }

  return (
    <>
      <div className="page">
        <header className="topbar">
          <span className="brand">
            <i className="brand-dot" /> liquid-glass<b>/react</b>
          </span>
          <span className="topbar-note">
            Custom 1/4-SDF Canvas Refraction + Universal CSS Optics
          </span>
        </header>

        <Hero lens={lens} />
        <VideoScene glass={dock} />
        <DockScene glass={dock} />
        <BentoTestScene glass={dock} />
        <StressTestScene glass={dock} />

        <footer className="foot">
          <p>
            Universal cross-browser architecture: <code>domSnapshot.ts</code> + <code>refractionEngine.ts</code> sample a
            1/4-quadrant symmetric SDF bevel field directly on <code>&lt;canvas&gt;</code> cleanly across desktop and
            mobile browsers, while frost, the 1px directional specular rim, and inner reflection run in GPU-composited CSS.
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

      <PerfObserverHud />
    </>
  )
}
