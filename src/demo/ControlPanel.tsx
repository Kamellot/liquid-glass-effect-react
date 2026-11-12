import { useCallback, useId } from 'react'
import type { RefractionEngineMode, ResolvedRefractionPath } from '../glass'
import { PRESETS, SLIDERS, type DemoParams, type SliderDef } from './presets'

interface Props {
  params: DemoParams
  onChange: (patch: Partial<DemoParams>) => void
  engine: RefractionEngineMode
  onEngine: (e: RefractionEngineMode) => void
  resolvedPath: ResolvedRefractionPath
  stats: string
  open: boolean
  onToggle: () => void
}

function SliderRow({
  def,
  value,
  onChange,
}: {
  def: SliderDef
  value: number
  onChange: (v: number) => void
}) {
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

const ENGINES: { id: RefractionEngineMode; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'backdrop', label: 'SVG Backdrop' },
  { id: 'target', label: 'Target Filter' },
  { id: 'css', label: 'CSS Optics' },
]

const PATH_LABELS: Record<ResolvedRefractionPath, string> = {
  'backdrop-svg': 'backdrop-filter: url(#svg)',
  'target-svg': 'filter: url(#svg) on target layer',
  'css-optics': 'CSS optical layer only',
}

export function ControlPanel({
  params,
  onChange,
  engine,
  onEngine,
  resolvedPath,
  stats,
  open,
  onToggle,
}: Props) {
  const setParam = useCallback(
    (key: keyof DemoParams) => (val: number) => onChange({ [key]: val }),
    [onChange],
  )
  const left = SLIDERS.slice(0, 5)
  const right = SLIDERS.slice(5)

  return (
    <aside className={'cp' + (open ? '' : ' cp--closed')} aria-label="Liquid glass inspector">
      <div className="cp-head">
        <div className="cp-presets" role="group" aria-label="Optical presets">
          {PRESETS.map((preset) => (
            <button
              key={preset.name}
              type="button"
              className="chip"
              onClick={() => onChange(preset.params)}
            >
              {preset.name}
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
              {left.map((def) => (
                <SliderRow key={def.key} def={def} value={params[def.key]} onChange={setParam(def.key)} />
              ))}
            </div>
            <div className="cp-col">
              {right.map((def) => (
                <SliderRow key={def.key} def={def} value={params[def.key]} onChange={setParam(def.key)} />
              ))}
            </div>
          </div>

          <div className="cp-foot">
            <div className="cp-engine" role="group" aria-label="Refraction path">
              {ENGINES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={'seg' + (engine === item.id ? ' seg--on' : '')}
                  onClick={() => onEngine(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <span className="cp-stat">
              path: <b>{PATH_LABELS[resolvedPath]}</b>
            </span>
            <span className="cp-stat">{stats}</span>
          </div>
        </>
      )}
    </aside>
  )
}

