# liquid-glass-react

Zero-dependency Liquid Glass engine and `<LiquidGlass />` React + TypeScript component combining a custom 1/4-quadrant SDF edge-refraction generator (SVG displacement map) with hardware-accelerated CSS optics.

```bash
npm install && npm run dev
```

## Architecture

- [`src/glass/refractionEngine.ts`](src/glass/refractionEngine.ts) — Offscreen `<canvas>` 1/4-quadrant symmetric rounded-rect SDF displacement map generator (`R = ΔX`, `G = ΔY`, `128 = neutral`), PNG LRU cache, deduplicated global `<svg><defs>` filter registry (`chroma === 0` single `<feDisplacementMap>` vs `chroma > 0` R/G/B `<feColorMatrix>` + `<feBlend mode="screen">`), and monotonically versioned filter IDs for Safari/WebKit cache invalidation.
- [`src/glass/LiquidGlass.tsx`](src/glass/LiquidGlass.tsx) & [`src/glass/LiquidGlass.css`](src/glass/LiquidGlass.css) — Supports `mode="layer"` (Apple Material node tracking parent dimensions and border radius via `ResizeObserver`) and `mode="wrapper"` / `refractionTarget` (cross-browser `filter: url(#svg-id)` target refraction on Safari macOS/iOS & Firefox, plus native `backdrop-filter: url(#svg-id)` on Chromium), overlaid with pure CSS `backdrop-filter` blur, 1.5px `conic-gradient` masked specular rim, and directional inset volumetric glow.
