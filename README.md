# liquid-glass-react

Zero-dependency Liquid Glass React component and 1/4-quadrant SDF optical refraction engine combining WebGL/Canvas pixel displacement with GPU-composited CSS optics.

```bash
npm install liquid-glass-react
```

## Architecture

- [`src/glass/LiquidGlass.tsx`](src/glass/LiquidGlass.tsx) & [`src/glass/LiquidGlass.css`](src/glass/LiquidGlass.css) — `React.forwardRef` component supporting `mode="layer"` (Optical Material node tracking parent dimensions, border radius, and alpha tint via `ResizeObserver`) and `mode="wrapper"` / `refractionTarget`, overlaid with CSS `backdrop-filter` blur, directional specular rim, volumetric glow, and `prefers-reduced-motion` support.
- [`src/glass/refractionEngine.ts`](src/glass/refractionEngine.ts) — Computes sparse 1/4-quadrant symmetric squircle SDF bevel fields (Snell's law refraction + optional RGB chromatic dispersion), manages ref-counted bounded LRU caches, and renders WebGL/Canvas pixel displacement only inside the bevel ring.
- [`src/glass/domSnapshot.ts`](src/glass/domSnapshot.ts) — Shared DOM-to-Canvas backdrop rasterizer across multiple `<LiquidGlass />` consumers targeting the same scene.
- [`src/perf-monitor/index.ts`](src/perf-monitor/index.ts) — Optional standalone telemetry and A/B benchmarking module (`liquid-glass-react/perf-monitor`) with SSR-safe snapshot getters, P95/P99 frame tracking, and adaptive quality tiers.

## UI Background & Tinting

You can set a semi-transparent UI background color on any `<LiquidGlass />` element without doubling alpha over the refracted bevel:

1. **Parent CSS background (`mode="layer"`):** Style the parent Optical Material container (`background: rgba(...)`); `<LiquidGlass mode="layer" />` reads `getComputedStyle(parent).backgroundColor` automatically.
   ```tsx
   <div style={{ position: 'relative', borderRadius: 28, background: 'rgba(38, 42, 58, 0.34)' }}>
     <LiquidGlass mode="layer" refractionTarget={sceneRef} />
   </div>
   ```
2. **Inline style or CSS class (`mode="wrapper"`):** Pass `style={{ backgroundColor: 'rgba(...)' }}` or a styled `className` directly on `<LiquidGlass mode="wrapper" />`.
   ```tsx
   <LiquidGlass mode="wrapper" style={{ backgroundColor: 'rgba(94, 92, 230, 0.28)' }} refractionTarget={sceneRef}>
     <span>Floating Pill</span>
   </LiquidGlass>
   ```
3. **`tint` prop (either mode):** Pass any CSS color string via `tint` (takes priority over parent fill in `mode="layer"`).
   ```tsx
   <LiquidGlass mode="wrapper" tint="rgba(32, 168, 96, 0.26)" refractionTarget={sceneRef}>
     <input placeholder="Search..." />
   </LiquidGlass>
   ```
