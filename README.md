# liquid-glass-react

Zero-dependency Liquid Glass engine and `<LiquidGlass />` React + TypeScript component combining a custom 1/4-quadrant SDF Canvas refraction engine (working uniformly across Chrome Desktop, Chrome iOS, Safari iOS/macOS, and Firefox) with universal hardware-accelerated CSS optics.

```bash
npm install && npm run dev
```

## Architecture

- [`src/glass/refractionEngine.ts`](src/glass/refractionEngine.ts) — Computes sparse 1/4-quadrant symmetric rounded-rectangle SDF bevel fields (Snell's law + optional RGB chromatic dispersion), caches bevel fields & live R/G debug bitmaps (`128 = neutral`), and runs bilinear Canvas pixel refraction only inside the bevel ring.
- [`src/glass/domSnapshot.ts`](src/glass/domSnapshot.ts) — Zero-dependency DOM-to-Canvas backdrop rasterizer shared across multiple `<LiquidGlass />` consumers targeting the same scene, eliminating Safari/iOS WebKit SVG `<feDisplacementMap>` limitations.
- [`src/glass/LiquidGlass.tsx`](src/glass/LiquidGlass.tsx) & [`src/glass/LiquidGlass.css`](src/glass/LiquidGlass.css) — Supports `mode="layer"` (Apple Material node tracking parent dimensions, border radius, and alpha tint via `ResizeObserver`) and `mode="wrapper"` / `refractionTarget`, overlaid with pure CSS `backdrop-filter` blur, 1.5px directional / Apple-style specular rim, and volumetric glow.
