# liquid-glass-react

Lightweight, zero-dependency React optical glass and edge-refraction component powered by a 1/4-quadrant Signed Distance Field (SDF) WebGL/Canvas engine and GPU-composited CSS optics.

- **Real DOM Refraction:** Physically bends and disperses live HTML content (text, images, video, and UI elements) along curved edges using a rasterized `refractionTarget` snapshot—no heavy full-scene WebGL renderers or DOM-cloning hacks.
- **Hybrid GPU Pipeline:** Combines a symmetric 1/4-quadrant SDF bevel engine (WebGL shader with a 5-level bicubic blur pyramid and bilinear CPU `<canvas>` fallback) with hardware-accelerated CSS optics (frost blur, directional specular rim highlights, and volumetric inner glow).
- **Multi-Instance Performance:** Ref-counted `BevelField` deduplication, bounded LRU bitmap caching, shared `ResizeObserver` / `IntersectionObserver` tracking, and frame-budgeted `requestAnimationFrame` draw batching sustain 60–120 fps across dozens of glass surfaces.
- **Flexible DOM Composition:** Works as an injected material layer (`mode="layer"`) inside existing containers with alpha fills or as a standalone wrapper (`mode="wrapper"`).

---

## Installation

```bash
npm install liquid-glass-react
```

```bash
pnpm add liquid-glass-react
```

```bash
yarn add liquid-glass-react
```

**Peer dependencies:** `react` (`^18.0.0 || ^19.0.0`) and `react-dom` (`^18.0.0 || ^19.0.0`).

Styles are imported automatically by the package entry (`liquid-glass-react/styles.css` is also exported if your setup requires an explicit stylesheet import).

---

## Quick Start

### 1. Material Layer Pattern (`mode="layer"`)

Drop `<LiquidGlass />` inside an existing container that already defines its own dimensions, `borderRadius`, and semi-transparent background fill. In `mode="layer"` (the default), `<LiquidGlass />` automatically inherits the parent's radius and computed background tint without doubling alpha across the refracted bevel, while keeping interactive children above the glass surface.

```tsx
import { useRef } from 'react'
import { LiquidGlass } from 'liquid-glass-react'

export function FloatingBar() {
  const sceneRef = useRef<HTMLDivElement>(null)

  return (
    <div ref={sceneRef} style={{ position: 'relative', minHeight: 400 }}>
      {/* Underlying scene content */}
      <img src="/backdrop.jpg" alt="" style={{ width: '100%', display: 'block' }} />

      {/* Glass container with its own alpha fill and radius */}
      <div
        style={{
          position: 'absolute',
          bottom: 24,
          left: '50%',
          transform: 'translateX(-50%)',
          borderRadius: 28,
          backgroundColor: 'rgba(38, 42, 58, 0.34)',
          padding: '10px 18px',
        }}
      >
        <LiquidGlass mode="layer" refractionTarget={sceneRef} />

        <div style={{ position: 'relative', zIndex: 1, display: 'flex', gap: 12 }}>
          <button type="button">Home</button>
          <button type="button">Library</button>
        </div>
      </div>
    </div>
  )
}
```

### 2. Wrapper / Target Refraction Pattern (`mode="wrapper"` / `refractionTarget`)

Use `mode="wrapper"` when `<LiquidGlass />` should act as the container itself, wrapping child elements directly or rendering a standalone refractive lens.

```tsx
import { useRef } from 'react'
import { LiquidGlass } from 'liquid-glass-react'

export function SearchPill() {
  const sceneRef = useRef<HTMLElement>(null)

  return (
    <section ref={sceneRef} style={{ position: 'relative', padding: 48 }}>
      <p>Background typography and media bend physically behind the bevel.</p>

      <LiquidGlass
        mode="wrapper"
        refractionTarget={sceneRef}
        borderRadius={999}
        refraction={75}
        depth={28}
        dispersion={24}
        frost={8}
        tint="rgba(255, 255, 255, 0.14)"
        style={{ padding: '10px 18px', display: 'inline-flex', alignItems: 'center' }}
      >
        <input type="search" placeholder="Search..." style={{ background: 'transparent', border: 0 }} />
      </LiquidGlass>
    </section>
  )
}
```

> **Tip:** Without `refractionTarget`, `<LiquidGlass />` automatically runs in CSS-only optics mode (`data-lg-engine="css-optics"`), rendering frost, inner glow, and specular rim lighting without requiring a scene reference. Add `data-lg-ignore=""` to floating sibling wrappers that should be excluded from the captured scene snapshot.

---

## API

`<LiquidGlass />` is wrapped in `React.memo` and `React.forwardRef<HTMLDivElement, LiquidGlassProps>`, forwarding all standard `HTMLDivElement` attributes (excluding `color`) and arbitrary `data-*` attributes to the root `<div>`.

| Prop | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `mode` | `'layer' \| 'wrapper'` | `'layer'` | Composition mode. `'layer'` fills its parent (`inset: 0`) and inherits `border-radius` and parent background tint; `'wrapper'` acts as a relative container around `children`. |
| `refractionTarget` | `RefObject<HTMLElement \| null> \| HTMLElement \| null` | `undefined` | Scene element or ref to capture and refract across the curved bevel (`canvas-sdf` engine). Omit to use CSS-only optics (`css-optics` engine). |
| `refraction` | `number` | `70` | Edge light-bending strength (`0–100`). Scales rim pull distance up to `1.5×` effective bevel depth. |
| `depth` | `number` | `30` | Physical bevel/rim width in CSS pixels measured inward from the outer edge (`0–100`). |
| `dispersion` | `number` | `20` | Chromatic RGB channel separation confined to the curved bevel (`0–100`). |
| `frost` | `number` | `6` | Frosted surface diffusion (`0–100`), applying Gaussian-like blur and a subtle saturation boost. |
| `splay` | `number` | `20` | Bevel falloff smoothness (`0–100`). Controls the power curve easing from the bent rim into the flat interior. |
| `lightMode` | `'natural' \| 'custom'` | `'natural'` | Rim/glow lighting style. `'natural'` renders symmetric top and bottom specular borders; `'custom'` uses `lightAngle` for directional lighting. |
| `lightAngle` | `number` | `0` | Light source bearing in degrees (`0–360`, `0` = top) used when `lightMode="custom"`. |
| `lightIntensity` | `number` | `40` | Specular rim brightness (`0–100`). |
| `glow` | `number` | `28` | Natural white inner glow / volumetric specular bloom (`0–100`). |
| `borderRadius` | `number \| string` | `undefined` | Corner radius (`number` in px or any CSS radius string). Omit to inherit from the parent or stylesheet. |
| `size` | `number` | `undefined` | Explicit square diameter (`px`) applied with `borderRadius: '50%'` when `mode="wrapper"`. Standalone wrappers default to `166px` in CSS. |
| `tint` | `string` | `undefined` | Optional CSS color tint blended seamlessly across both the interior and refracted bevel. Overrides parent fill detection in `mode="layer"`. |
| `fill` | `string \| boolean` | `undefined` | Base surface color for Fill + Shadow mode (e.g. `'#101010'`, `'rgb(30 64 175 / 0.75)'`), or `true` for `#101010`. |
| `fillOverlay` | `string` | `undefined` | Top surface sheen layered over `fill` (defaults to `'rgb(255 255 255 / 0.04)'` when `fill` is set). Pass `'none'` or `'transparent'` to disable. |
| `shadow` | `string \| boolean` | `undefined` | Edge/drop shadows for Fill + Shadow mode. `true` (or omitted when `fill` is set) applies directional edge shadows; pass a CSS `box-shadow` string to customize, or `false` / `'none'` to disable. |
| `ignoreGlobal` | `boolean` | `false` | Skips global defaults from `configureLiquidGlass()` and `<LiquidGlassProvider>`. |
| `onMapUpdate` | `(info: DisplacementMapInfo) => void` | `undefined` | Callback invoked when the active bevel field or R/G displacement debug map updates. |
| `...divProps` | `Omit<HTMLAttributes<HTMLDivElement>, 'color'>` | — | Standard `<div>` props (`className`, `style`, `id`, `role`, `aria-*`, `data-*`, event handlers) and `ref`. |

### Global Configuration

You can set app-wide defaults once via `configureLiquidGlass()` without wrapping your component tree, or scope overrides to a subtree with `<LiquidGlassProvider>`:

```tsx
import { configureLiquidGlass, LiquidGlassProvider } from 'liquid-glass-react'

// App-wide defaults (no provider wrapper required)
configureLiquidGlass({
  frost: 10,
  dispersion: 24,
  lightMode: 'custom',
  lightAngle: 35,
})

// Optional subtree override
<LiquidGlassProvider config={{ tint: 'rgba(20, 24, 38, 0.35)' }}>
  {children}
</LiquidGlassProvider>
```

---

## How It Works

### 1. 1/4-Quadrant SDF & Squircle Math

`refractionEngine.ts` and `webglRefraction.ts` model every glass surface using a symmetric rounded-rectangle Signed Distance Field evaluated across only a single quadrant (`(cx, cy)` relative to center) and mirrored across the X and Y axes, cutting CPU bevel generation work by 75%:

- **Continuous Squircle Corners:** Corner normals blend smoothly from circular (`n = 2.0`) to superellipse curvature (`SQUIRCLE_EXPONENT = 2.8`) based on straight-edge ratio, preserving exact circles while eliminating curvature discontinuities at rounded-rectangle corner joints.
- **Convex Bevel Falloff:** Normalized inward distance $u = 1 - d / \text{effectiveDepth}$ is shaped by $f(u, p) = u^p$ where $p = 1.5 + (\text{splay} / 100) \times 3.0$, guaranteeing a $C^1$ tangent transition ($f(0) = f'(0) = 0$) into the flat center.

### 2. Flat-Center + Rim Bevel Displacement

Rather than warping the entire surface, refractive displacement is confined strictly to the outer bevel ring (`distInward < effectiveDepth`):

- **WebGL Path (`webglRefraction.ts`):** Shades the bevel in a single fragment pass using the shared DOM snapshot texture, applying 5-tap weighted RGB chromatic dispersion (`spread`) along outward SDF normals, optional 5-level dual-filter downsample frost blur with Sigg-Hadwiger B-spline bicubic upsampling, interleaved gradient noise dithering, and seamless `u_tint` mixing.
- **CPU Canvas Fallback (`refractionEngine.ts`):** Precomputes sparse pixel arrays (`px`, `py`, `vecX`, `vecY`, `alpha`, `indices`) only for pixels inside the bevel ring, composites the unwarped flat center directly from the snapshot, and performs bilinear sampling along the bevel. When `onMapUpdate` is supplied, `generateDisplacementMap()` also encodes an R/G displacement debug map centered at neutral `128`.

### 3. CSS Optical Layer

Lighting, surface depth, and fallback frost are offloaded to lightweight CSS layers in `LiquidGlass.css` driven by custom properties (`--lg-frost-blur`, `--lg-frost-sat`, `--lg-light`, `--lg-glow`, `--lg-lx`, `--lg-ly`):

- **Specular Rim (`.lg-rim`):** Uses zero-blur inset `box-shadow` highlights instead of per-element offscreen `mask-composite` surfaces, avoiding extra compositor allocations.
- **Volumetric Glow (`.lg-glow`):** Renders either symmetric top/bottom linear gradients (`lightMode="natural"`) or light-vector-positioned radial gradients (`lightMode="custom"`).
- **Frost Diffusion (`.lg-frost`):** When WebGL frost is inactive, applies `backdrop-filter: blur(...) saturate(...)` and automatically disables it when scrolled offscreen (`data-lg-offscreen="1"`).

### 4. Caching, Snapshots & Lifecycle

- **Bevel Field Deduplication:** `acquireBevelField()` hashes quantized dimensions, `borderRadius`, `depth`, `splay`, and adaptive render scale (`buildBevelHash()`), sharing a single `BevelField` across identical instances with automatic reference-counted cleanup via `releaseBevelField()` and a bounded LRU `bitmapCache` (`MAX_BITMAP_CACHE = 40`).
- **Shared Scene Snapshots (`domSnapshot.ts`):** Multiple `<LiquidGlass />` instances targeting the same `refractionTarget` share one rasterized `TargetSnapshot`, automatically ignoring `[data-lg-root]` and `[data-lg-ignore]` subtrees and observing DOM mutations, resizes, visibility, and live `<video>` frames (`requestVideoFrameCallback`).
- **Scheduled Batching (`glassScheduler.ts`):** Uses shared `ResizeObserver` and `IntersectionObserver` registries plus frame-budgeted `requestAnimationFrame` draw batching (`5ms` budget per frame after `4` minimum operations).

---

## Known Limitations

- **Snapshot Capture & Cross-Origin / Hardware-Protected Media:** Real-time edge refraction samples a rasterized `<canvas>` / WebGL texture captured from `refractionTarget`. Cross-origin images or videos without CORS permissions (`crossOrigin="anonymous"`), embedded iframes, and DRM/hardware-protected `<video>` planes cannot be read into the snapshot pipeline.
- **Requires `refractionTarget` for Pixel Bending:** Passing `refractionTarget` activates live SDF pixel refraction (`canvas-sdf`). When `refractionTarget` is omitted, `<LiquidGlass />` renders only the CSS optical layers (frost blur, specular rim, and inner glow).
- **Large Surface Footprints:** Very large full-viewport glass containers increase texture upload and rasterization costs. The engine enforces pixel budgets (`MAX_WEBGL_PIXEL_BUDGET = 140,000`, `MAX_BEVEL_BUDGET = 72,000`, `MAX_SNAP_DIM = 2200`, `MAX_VIDEO_SNAP_DIM = 960`), making the component best suited for UI controls, cards, docks, pills, and lenses.
- **WebGL Fallback Trade-offs:** Environments where WebGL is unavailable or context-lost fall back to bilinear CPU `<canvas>` bevel rendering paired with CSS `backdrop-filter` frost, which has higher CPU overhead during continuous drags or video playback.

---

## FAQ

### Can I render multiple `<LiquidGlass />` components on the same screen without lag?

Yes. Identical glass geometries share a single cached `BevelField` via reference counting (`acquireBevelField` / `releaseBevelField`), all instances pointing at the same `refractionTarget` reuse one shared DOM snapshot, lighting and specular rims are rendered with zero-mask CSS `box-shadow` and gradients, offscreen elements are paused by `IntersectionObserver`, and redraws are paced by a frame-budgeted `requestAnimationFrame` scheduler.

### How do I combine it with my own semi-transparent background color?

You have three options, all designed to avoid doubling alpha over the refracted bevel:
1. **Parent CSS background (`mode="layer"`):** Set `backgroundColor: 'rgba(...)'` on the parent container; `<LiquidGlass mode="layer" />` reads `getComputedStyle(parent).backgroundColor` automatically.
2. **`tint` prop (either mode):** Pass any CSS color to `tint="rgba(...)"` (takes precedence over parent background detection in `mode="layer"`).
3. **`style` / `className` (`mode="wrapper"`):** Pass `style={{ backgroundColor: 'rgba(...)' }}` directly on `<LiquidGlass mode="wrapper" />`.

### Is it compatible with Next.js / SSR?

Yes. The package contains no top-level `window`, `document`, `ResizeObserver`, or `IntersectionObserver` references, guards layout effects with an isomorphic `useLayoutEffect` / `useEffect` wrapper, and defers canvas/WebGL initialization until client mount. Ensure `'use client'` is present in Next.js App Router components that render `<LiquidGlass />` with refs or interactive state.

### How does it handle `prefers-reduced-motion`?

`LiquidGlass` initializes its reduced-motion state to `false` for deterministic SSR hydration, then subscribes to `window.matchMedia('(prefers-reduced-motion: reduce)')`. When reduced motion is active, dynamic `refraction` and `dispersion` values are scaled to `25%` (`REDUCED_MOTION_DISPLACEMENT_SCALE = 0.25`), multi-frame transition animation loops collapse to a single redraw, and `LiquidGlass.css` clamps CSS transition and animation durations inside `.lg-root` to `0.01ms`.

---

## Development

```bash
# Start the local interactive playground (Vite dev server)
npm run dev

# Type-check and build the demo application
npm run build

# Build the publishable ESM library bundle, styles.css, and TypeScript declarations
npm run build:lib

# Preview the built demo application
npm run preview

# Run the Node unit test suite (config, SSR, and perf-monitor tests)
npm test
```
