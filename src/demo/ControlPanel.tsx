import { useCallback, useId } from 'react'
import type { SpecularMode } from '../glass'
import { PRESETS, SLIDERS, type DemoParams, type SliderDef } from './presets'

interface Props {
  params: DemoParams
  onChange: (patch: Partial<DemoParams>) => void
  specularMode: SpecularMode
  onSpecularMode: (mode: SpecularMode) => void
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
      <div
        className={'cp-row' + (disabled ? ' cp-row--dim' : '')}
        title={disabled ? 'Switch Shine to Directional to adjust angle' : undefined}
      >
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

const SHINE_MODES: {id: SpecularMode; label: string }[] = [
      {id: 'directional', label: 'Directional' },
      {id: 'apple', label: 'Apple Official' },
      ]

      export function ControlPanel({
        params,
        onChange,
        specularMode,
        onSpecularMode,
        stats,
        open,
        onToggle,
}: Props) {
  const setParam = useCallback(
    (key: keyof DemoParams) => (val: number) => onChange({[key]: val }),
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
                <SliderRow
                  key={def.key}
                  def={def}
                  value={params[def.key]}
                  disabled={def.key === 'specularAngle' && specularMode === 'apple'}
                  onChange={setParam(def.key)}
                />
                ))}
              </div>
            </div>

            <div className="cp-foot">
              <div className="cp-shine" role="group" aria-label="Specular shine style">
                <span className="cp-foot-label">Shine:</span>
                {SHINE_MODES.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={'seg' + (specularMode === m.id ? ' seg--on' : '')}
                    onClick={() => onSpecularMode(m.id)}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              <span className="cp-stat">
                engine: <b>1/4 Quadrant SDF · Universal SVG + CSS Optics</b>
              </span>
              <span className="cp-stat">{stats}</span>
            </div>
          </>
        )}
      </aside>
      )
}
