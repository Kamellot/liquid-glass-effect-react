import { useCallback, useId } from 'react'
import { PRESETS, SLIDERS, type DemoParams, type SliderDef } from './presets'

interface Props {
  params: DemoParams
  onChange: (patch: Partial<DemoParams>) => void
  stats: string
  open: boolean
  onToggle: () => void
}

function SliderRow({
  def,
  value,
  disabled,
  onChange,
}: {
  def: SliderDef
  value: number
  disabled?: boolean
  onChange: (v: number) => void
}) {
  const id = useId()
  const pct = ((value - def.min) / (def.max - def.min)) * 100
  return (
    <div className={'cp-row' + (disabled ? ' cp-row--dim' : '')}>
      <label htmlFor={id}>{def.label}</label>
      <input
        id={id}
        type="range"
        min={def.min}
        max={def.max}
        step={def.step}
        value={value}
        disabled={disabled}
        style={{ '--pct': `${pct}%` } as React.CSSProperties}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
      <output htmlFor={id}>{value.toFixed(def.decimals)}</output>
    </div>
  )
}

export function ControlPanel({ params, onChange, stats, open, onToggle }: Props) {
  const setParam = useCallback(
    (key: SliderDef['key']) => (val: number) => onChange({ [key]: val }),
    [onChange],
  )
  const isNaturalLight = params.lightMode === 'natural'

  const half = Math.ceil(SLIDERS.length / 2)
  const left = SLIDERS.slice(0, half)
  const right = SLIDERS.slice(half)

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
        <div className="cp-head-actions">
          {open && (
            <div className="cp-light-switch" role="group" aria-label="Lighting mode">
              <button
                type="button"
                className={'seg' + (isNaturalLight ? ' seg--active' : '')}
                aria-pressed={isNaturalLight}
                onClick={() => onChange({ lightMode: 'natural' })}
              >
                Natural
              </button>
              <button
                type="button"
                className={'seg' + (!isNaturalLight ? ' seg--active' : '')}
                aria-pressed={!isNaturalLight}
                onClick={() => onChange({ lightMode: 'custom' })}
              >
                Custom
              </button>
            </div>
          )}
          <button type="button" className="cp-toggle" onClick={onToggle} aria-expanded={open}>
            {open ? 'Hide' : 'Controls'}
          </button>
        </div>
      </div>

      {open && (
        <>
          <div className="cp-grid">
            <div className="cp-col">
              {left.map((def) => (
                <SliderRow
                  key={def.key}
                  def={def}
                  value={params[def.key]}
                  disabled={isNaturalLight && def.key === 'lightAngle'}
                  onChange={setParam(def.key)}
                />
              ))}
            </div>
            <div className="cp-col">
              {right.map((def) => (
                <SliderRow
                  key={def.key}
                  def={def}
                  value={params[def.key]}
                  disabled={isNaturalLight && def.key === 'lightAngle'}
                  onChange={setParam(def.key)}
                />
              ))}
            </div>
          </div>

          <div className="cp-foot">
            <span className="cp-stat">
              engine: <b>Custom 1/4-SDF Canvas + CSS Optics</b>
            </span>
            <span className="cp-stat">{stats}</span>
          </div>
        </>
      )}
    </aside>
  )
}
