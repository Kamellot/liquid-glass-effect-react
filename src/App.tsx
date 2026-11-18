import { useRef } from 'react';
import { FloatingGlassLens } from './components/FloatingGlassLens';
import { HeroSection } from './components/HeroSection';

export default function App() {
  const pageRef = useRef<HTMLElement | null>(null);

  return (
    <main id="top" ref={pageRef} className="app-shell">
      <HeroSection />
      <FloatingGlassLens pageRef={pageRef} />
    </main>
  );
}
