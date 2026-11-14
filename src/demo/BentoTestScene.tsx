import { useRef } from 'react'
import { LiquidGlass, type LiquidGlassProps } from '../glass'

interface BentoTestSceneProps {
  glass: LiquidGlassProps
}

function BentoTile({
  className,
  glass,
}: {
  className: string
  glass: LiquidGlassProps
}) {
  const tileRef = useRef<HTMLDivElement>(null)

  return (
    <div ref={tileRef} className={`bento-tile ${className}`}>
      <LiquidGlass
        {...glass}
        mode="wrapper"
        borderRadius={28}
        style={{ width: '72%', height: '58%' }}
        refractionTarget={tileRef}
      />
    </div>
  )
}

export function BentoTestScene({ glass }: BentoTestSceneProps) {
  return (
    <section className="bento-section" aria-label="Bare LiquidGlass background tests">
      <div className="section-head">
        <h2>Background Test — Bento</h2>
        <p>
          Bare <code>&lt;LiquidGlass /&gt;</code> rounded rectangles with no extra CSS or DOM elements on solid white,
          solid black, white abstract, and dark abstract backgrounds.
        </p>
      </div>

      <div className="bento-grid">
        <BentoTile className="bento-tile--white" glass={glass} />
        <BentoTile className="bento-tile--black" glass={glass} />
        <BentoTile className="bento-tile--white-abstract" glass={glass} />
        <BentoTile className="bento-tile--dark-abstract" glass={glass} />
      </div>
    </section>
  )
}
