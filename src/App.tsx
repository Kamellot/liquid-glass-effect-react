import ColorBends from './components/ColorBends';

export default function App() {
  return (
    <main className="app-shell">
      <div className="app-backdrop" aria-hidden="true">
        <ColorBends
          colors={['#5568f7']}
          rotation={-29}
          speed={0.1}
          scale={3.2}
          frequency={1.7}
          warpStrength={1}
          mouseInfluence={0}
          noise={0.13}
          parallax={0}
          iterations={1}
          intensity={0.7}
          bandWidth={6}
          transparent
          autoRotate={-1}
        />
      </div>
    </main>
  );
}
