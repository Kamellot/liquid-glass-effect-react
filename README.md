# liquid-glass-react

PoC of Apple's "Liquid Glass" refraction in React + TypeScript — no WebGL, no screen capture.

```bash
npm install && npm run dev      # http://127.0.0.1:5173  (add ?engine=fallback to force the WebKit path)
```

```tsx
// Material layer: drop into any element that already has fill + shadow
<div className="dock"><LiquidGlass strength={0.08} chroma={1} /> …icons…</div>
// Standalone circular lens / wrapper
<LiquidGlass mode="wrapper" size={166}>…</LiquidGlass>
```

- `src/glass/displacementMap.ts` – offscreen-canvas SDF → R/G displacement bitmap (cached by geometry + depth/curvature/splay).
- `src/glass/filterRegistry.ts` – one ref-counted `<filter>` per hash `w_h_r_depth_curvature_splay_strength_chroma_blur`; `chroma = 0` uses a single `feDisplacementMap`.
- `src/glass/engine.ts` – feature + engine detection (WebKit/iOS → bevel-ring fallback).
- `src/glass/LiquidGlass.{tsx,css}` – component; rim (conic-gradient + composite mask) and glow (inset box-shadows) are pure CSS vars driven by `specularAngle`.
