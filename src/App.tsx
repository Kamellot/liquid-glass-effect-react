import GradientBlinds from './components/GradientBlinds';

export default function App() {
  return (
    <main className="app-shell">
      <div className="app-backdrop" aria-hidden="true">
        <GradientBlinds
          gradientColors={['#1625f9', '#6366f1', '#1e3a8a']}
          angle={1}
          blindCount={64}
          blindMinWidth={60}
          spotlightRadius={0.47}
          shine={0.67}
          relief={0.92}
          glow={0.35}
          sway={0.41}
          hoverTilt={0.45}
          clickEffect="ripple"
          noise={0.24}
          spotlightSoftness={1.15}
          lightColor="#f6caff"
          perspective={0.06}
          gradientSpeed={3.95}
          distortAmount={9}
        />
      </div>
    </main>
  );
}
