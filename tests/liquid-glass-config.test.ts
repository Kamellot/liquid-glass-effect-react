import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DEFAULTS, LiquidGlass, LiquidGlassProvider } from '../src/glass'

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
