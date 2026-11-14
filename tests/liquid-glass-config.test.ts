import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement, createRef } from 'react'
import { renderToStaticMarkup, renderToString } from 'react-dom/server'
import {
  buildBevelHash,
  clamp,
  clamp01,
  configureLiquidGlass,
  DEFAULT_GLASS_CONFIG,
  DEFAULTS,
  degToRad,
  isTransparentColor,
  LiquidGlass,
  LiquidGlassProvider,
  OPTICAL_MATERIAL_DEFAULTS,
  parseCssColorRgba,
  resetLiquidGlassConfig,
} from '../src/index'

test('LiquidGlass works standalone without LiquidGlassProvider (opt-in)', () => {
  const html = renderToStaticMarkup(createElement(LiquidGlass))

  assert.match(html, /data-lg-light-mode="natural"/)
  assert.match(html, new RegExp(`--lg-glow:${(DEFAULTS.glow / 100).toFixed(3)}`))
  assert.match(html, new RegExp(`--lg-light:${(DEFAULTS.lightIntensity / 50).toFixed(3)}`))
  assert.match(html, /--lg-frost-blur:1\.20px/)
})

test('LiquidGlassProvider applies global configuration to descendant instances', () => {
  const html = renderToStaticMarkup(
    createElement(
      LiquidGlassProvider,
      {
        value: {
          lightMode: 'custom',
          lightAngle: 120,
          lightIntensity: 80,
          glow: 60,
          frost: 20,
          tint: 'rgba(10, 20, 30, 0.4)',
          borderRadius: 24,
          size: 180,
        },
      },
      createElement(LiquidGlass, { mode: 'wrapper' }),
    ),
  )

  assert.match(html, /data-lg-light-mode="custom"/)
  assert.match(html, /--lg-light-angle:120deg/)
  assert.match(html, /--lg-light:1\.600/)
  assert.match(html, /--lg-glow:0\.600/)
  assert.match(html, /--lg-frost-blur:4\.00px/)
  assert.match(html, /background-color:rgba\(10, 20, 30, 0\.4\)/)
  assert.match(html, /border-radius:24px/)
  assert.match(html, /width:180px/)
  assert.match(html, /height:180px/)
})

test('Per-instance props override matching global options while inheriting others', () => {
  const html = renderToStaticMarkup(
    createElement(
      LiquidGlassProvider,
      {
        config: {
          lightMode: 'custom',
          glow: 75,
          frost: 20,
          tint: 'rgba(0, 0, 0, 0.3)',
        },
      },
      createElement(LiquidGlass, {
        lightMode: 'natural',
        glow: 10,
      }),
    ),
  )

  assert.match(html, /data-lg-light-mode="natural"/)
  assert.match(html, /--lg-glow:0\.100/)
  // Still inherits frost and tint from global config
  assert.match(html, /--lg-frost-blur:4\.00px/)
  assert.match(html, /background-color:rgba\(0, 0, 0, 0\.3\)/)
})

test('ignoreGlobal skips LiquidGlassProvider configuration and falls back to defaults + local props', () => {
  const html = renderToStaticMarkup(
    createElement(
      LiquidGlassProvider,
      {
        value: {
          lightMode: 'custom',
          glow: 90,
          frost: 40,
          tint: 'rgba(255, 0, 0, 0.5)',
          size: 200,
        },
      },
      createElement(LiquidGlass, {
        mode: 'wrapper',
        ignoreGlobal: true,
        glow: 15,
      }),
    ),
  )

  assert.match(html, /data-lg-light-mode="natural"/)
  assert.match(html, /--lg-glow:0\.150/)
  assert.match(html, /--lg-frost-blur:1\.20px/)
  assert.doesNotMatch(html, /background-color:/)
  assert.doesNotMatch(html, /width:200px/)
})

test('Nested LiquidGlassProvider merges with parent by default and supports inherit={false}', () => {
  const mergedHtml = renderToStaticMarkup(
    createElement(
      LiquidGlassProvider,
      { value: { glow: 80, tint: 'rgba(1, 2, 3, 0.4)' } },
      createElement(
        LiquidGlassProvider,
        { value: { lightMode: 'custom', glow: 50 } },
        createElement(LiquidGlass),
      ),
    ),
  )

  assert.match(mergedHtml, /data-lg-light-mode="custom"/)
  assert.match(mergedHtml, /--lg-glow:0\.500/)
  assert.match(mergedHtml, /background-color:rgba\(1, 2, 3, 0\.4\)/)

  const isolatedHtml = renderToStaticMarkup(
    createElement(
      LiquidGlassProvider,
      { value: { glow: 80, tint: 'rgba(1, 2, 3, 0.4)' } },
      createElement(
        LiquidGlassProvider,
        { value: { lightMode: 'custom' }, inherit: false },
        createElement(LiquidGlass),
      ),
    ),
  )

  assert.match(isolatedHtml, /data-lg-light-mode="custom"/)
  assert.match(isolatedHtml, new RegExp(`--lg-glow:${(DEFAULTS.glow / 100).toFixed(3)}`))
  assert.doesNotMatch(isolatedHtml, /background-color:/)
})

test('configureLiquidGlass applies global defaults without any provider wrapper and supports overrides + ignoreGlobal', () => {
  try {
    configureLiquidGlass({
      lightMode: 'custom',
      lightAngle: 90,
      glow: 72,
      frost: 25,
      tint: 'rgba(12, 34, 56, 0.5)',
    })

    const globalHtml = renderToStaticMarkup(createElement(LiquidGlass))
    assert.match(globalHtml, /data-lg-light-mode="custom"/)
    assert.match(globalHtml, /--lg-light-angle:90deg/)
    assert.match(globalHtml, /--lg-glow:0\.720/)
    assert.match(globalHtml, /--lg-frost-blur:5\.00px/)
    assert.match(globalHtml, /background-color:rgba\(12, 34, 56, 0\.5\)/)

    const overrideHtml = renderToStaticMarkup(
      createElement(LiquidGlass, { lightMode: 'natural', glow: 12 }),
    )
    assert.match(overrideHtml, /data-lg-light-mode="natural"/)
    assert.match(overrideHtml, /--lg-glow:0\.120/)
    assert.match(overrideHtml, /--lg-frost-blur:5\.00px/)

    const ignoredHtml = renderToStaticMarkup(
      createElement(LiquidGlass, { ignoreGlobal: true }),
    )
    assert.match(ignoredHtml, /data-lg-light-mode="natural"/)
    assert.match(ignoredHtml, new RegExp(`--lg-glow:${(DEFAULTS.glow / 100).toFixed(3)}`))
    assert.doesNotMatch(ignoredHtml, /background-color:/)
  } finally {
    resetLiquidGlassConfig()
  }
})

test('LiquidGlass forwards ref, standard HTMLAttributes, and renders deterministically in SSR', () => {
  const ref = createRef<HTMLDivElement>()
  const html = renderToString(
    createElement(
      LiquidGlass,
      {
        ref,
        mode: 'wrapper',
        id: 'hero-lens',
        className: 'custom-lens',
        role: 'region',
        'aria-label': 'Interactive lens',
        'data-testid': 'glass-node',
        onClick: () => {},
        fill: true,
      },
      createElement('span', null, 'Lens Body'),
    ),
  )

  assert.equal(LiquidGlass.displayName, 'LiquidGlass')
  assert.equal(ref.current, null)
  assert.strictEqual(DEFAULTS, DEFAULT_GLASS_CONFIG)
  assert.match(html, /id="hero-lens"/)
  assert.match(html, /class="lg-root lg-root--wrapper custom-lens"/)
  assert.match(html, /role="region"/)
  assert.match(html, /aria-label="Interactive lens"/)
  assert.match(html, /data-testid="glass-node"/)
  assert.match(html, /data-lg-engine="css-optics"/)
  assert.match(html, /class="lg-fill"/)
  assert.match(html, /Lens Body/)
  assert.ok(OPTICAL_MATERIAL_DEFAULTS.shadow.includes('-1.25px'))
})

test('Shared pure optical utils and bevel hashing behave deterministically', () => {
  assert.equal(clamp(150, 0, 100), 100)
  assert.equal(clamp(-5, 0, 100), 0)
  assert.equal(clamp01(0.42), 0.42)
  assert.ok(Math.abs(degToRad(180) - Math.PI) < 1e-12)
  assert.deepEqual(parseCssColorRgba('rgba(255, 0, 51, 0.5)'), [1, 0, 51 / 255, 0.5])
  assert.equal(isTransparentColor('transparent'), true)
  assert.equal(isTransparentColor('rgba(0, 0, 0, 0)'), true)
  assert.equal(isTransparentColor('rgb(255, 255, 255)'), false)
  assert.equal(
    buildBevelHash({ width: 120, height: 60, borderRadius: 24, depth: 20, splay: 35, scale: 1 }),
    '120x60_r24.0_d20.0_s35.0_sc1.00',
  )
})
