import { useCallback, useId } from 'react'
import { PRESETS, SLIDERS, type DemoParams, type SliderDef } from './presets'
import type { GlassEngine, ResolvedEngine } from '../glass'

interface Props {
  params: DemoParams
  onChange: (patch: Partial<DemoParams>) => void
  engine: GlassEngine
  onEngine: (e: GlassEngine) => void
  resolvedEngine: ResolvedEngine
  stats: string
  open: boolean
  onToggle: () => void
}

function Row({ def, value, onChange }: { def: SliderDef; value: number; onChange: (v: number) => void }) {
  const id = useId()
  const pct = ((value - def.min) / (def.max - def.min)) * 100
  return (
    <div className="cp-row">
      <label htmlFor={id}>{def.label}</label>
      <input
        id={id}
        type="range"
        min={def.min}
        max={def.max}
        step={def.step}
        value={value}
        style={{ '--pct': `${pct}%` } as React.CSSProperties}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
      <output htmlFor={id}>{value.toFixed(def.decimals)}</output>
    </div>
  )
}

const ENGINES: { id: GlassEngine; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'webgl', label: 'WebGL' },
  { id: 'svg', label: 'SVG' },
  { id: 'fallback', label: 'CSS Ring' },
]

const PATH_LABELS: Record<ResolvedEngine, string> = {
  svg: 'backdrop-filter: url(#svg)',
  webgl: 'WebGL SDF shader (Safari / iOS)',
  fallback: 'CSS dual bevel-ring',
}

export function ControlPanel({ params, onChange, engine, onEngine, resolvedEngine, stats, open, onToggle }: Props) {
  const set = useCallback((key: keyof DemoParams) => (v: number) => onChange({ [key]: v }), [onChange])
  const left = SLIDERS.slice(0, 5)
  const right = SLIDERS.slice(5)

  return (
    <aside className={'cp' + (open ? '' : ' cp--closed')} aria-label="Liquid glass controls">
      <div className="cp-head">
        <div className="cp-presets" role="group" aria-label="Presets">
          {PRESETS.map((p) => (
            <button key={p.name} type="button" className="chip" onClick={() => onChange(p.params)}>
              {p.name}
            </button>
          ))}
        </div>
        <button type="button" className="cp-toggle" onClick={onToggle} aria-expanded={open}>
          {open ? 'Hide' : 'Controls'}
        </button>
      </div>

      {open && (
        <>
          <div className="cp-grid">
            <div className="cp-col">
              {left.map((d) => (
                <Row key={d.key} def={d} value={params[d.key]} onChange={set(d.key)} />
              ))}
            </div>
            <div className="cp-col">
              {right.map((d) => (
                <Row key={d.key} def={d} value={params[d.key]} onChange={set(d.key)} />
              ))}
            </div>
          </div>
          <div className="cp-foot">
            <div className="cp-engine" role="group" aria-label="Rendering engine">
              {ENGINES.map((e) => (
                <button key={e.id} type="button" className={'seg' + (engine === e.id ? ' seg--on' : '')} onClick={() => onEngine(e.id)}>
                  {e.label}
                </button>
              ))}
            </div>
            <span className="cp-stat">
              path: <b>{PATH_LABELS[resolvedEngine]}</b>
            </span>
            <span className="cp-stat">{stats}</span>
          </div>
        </>
      )}
    </aside>
  )
}
