import { useRef } from 'react'
import { LiquidGlass, type LiquidGlassProps } from '../glass'

interface StressTestSceneProps {
  glass: LiquidGlassProps
}

const ITEMS = Array.from({ length: 100 }, (_, i) => i)

export function StressTestScene({ glass }: StressTestSceneProps) {
  const stageRef = useRef<HTMLDivElement>(null)

  return (
    <section className="stress-section" aria-label="100 LiquidGlass performance stress test">
      <div className="section-head">
        <h2>Performance Stress Test — 100× LiquidGlass (200vh)</h2>
        <p>
          100 live <code>&lt;LiquidGlass /&gt;</code> elements rendered across a <code>200vh</code> stage to test
          scroll throughput, bevel field sharing, and FPS/jank in the Performance Observer HUD.
        </p>
      </div>

      <div ref={stageRef} className="stress-stage">
        {ITEMS.map((index) => (
          <LiquidGlass
            key={index}
            {...glass}
            mode="wrapper"
            borderRadius={22}
            className="stress-glass"
            refractionTarget={stageRef}
          />
        ))}
      </div>
    </section>
  )
}
