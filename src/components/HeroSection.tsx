import { useCallback, useEffect, useRef, useState } from 'react';
import GradientBlinds from './GradientBlinds';
import { CheckIcon, CopyIcon, GithubIcon, LogoIcon, NpmIcon } from './HeroIcons';
import './HeroSection.css';

const INSTALL_COMMAND = 'npm i liquid-glass-effect-react';
const NPM_URL = 'https://www.npmjs.com/package/liquid-glass-effect-react';
const GITHUB_URL = 'https://github.com/Kamellot/liquid-glass-effect-react';
const NPM_DOWNLOADS = '838';
const SNAPSHOT_INTERVAL_MS = 32;

export function HeroSection() {
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const frameTickRef = useRef(0);
  const lastNotifyRef = useRef(0);
  const trailingTimerRef = useRef<number | null>(null);

  const [copied, setCopied] = useState(false);
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < 768 : false,
  );
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(max-width: 767px)');
    setIsMobile(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    return () => {
      if (trailingTimerRef.current !== null) window.clearTimeout(trailingTimerRef.current);
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  // Throttled DOM signal inside refractionTarget so LiquidGlass refracts live GradientBlinds frames.
  const bumpSceneFrame = useCallback(() => {
    const el = backdropRef.current;
    if (!el) return;
    frameTickRef.current += 1;
    el.dataset.frame = String(frameTickRef.current);
    lastNotifyRef.current = performance.now();
  }, []);

  const handleBackdropDraw = useCallback(() => {
    const now = performance.now();
    const elapsed = now - lastNotifyRef.current;
    if (elapsed >= SNAPSHOT_INTERVAL_MS) {
      if (trailingTimerRef.current !== null) {
        window.clearTimeout(trailingTimerRef.current);
        trailingTimerRef.current = null;
      }
      bumpSceneFrame();
      return;
    }

    if (trailingTimerRef.current === null) {
      trailingTimerRef.current = window.setTimeout(() => {
        trailingTimerRef.current = null;
        bumpSceneFrame();
      }, SNAPSHOT_INTERVAL_MS - elapsed);
    }
  }, [bumpSceneFrame]);

  const handleCopyCommand = async () => {
    let success = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(INSTALL_COMMAND);
        success = true;
      }
    } catch {
      success = false;
    }

    if (!success && typeof document !== 'undefined') {
      const textarea = document.createElement('textarea');
      textarea.value = INSTALL_COMMAND;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        success = document.execCommand('copy');
      } catch {
        success = false;
      }
      document.body.removeChild(textarea);
    }

    if (success) {
      setCopied(true);
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => {
        setCopied(false);
        copyTimerRef.current = null;
      }, 1800);
    }
  };

  return (
    <section className="hero" aria-labelledby="hero-title">
      <div ref={backdropRef} className="hero-backdrop" aria-hidden="true">
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
          spotlightOrigin={isMobile ? [0.58, 0.28] : [0.5, 0.5]}
          preserveDrawingBuffer
          onDraw={handleBackdropDraw}
        />
        <div className="hero-vignette" />
      </div>

      <header className="hero-header">
        <a href="#top" className="hero-brand" aria-label="liquid glass effect react">
          <LogoIcon size={24} className="hero-brand-icon" />
          <span className="hero-brand-name">liquid glass effect</span>
          <span className="hero-brand-react">react</span>
        </a>

        <nav className="hero-nav" aria-label="Package links">
          <a
            href={NPM_URL}
            target="_blank"
            rel="noreferrer"
            className="hero-nav-npm"
            aria-label={`npm package (${NPM_DOWNLOADS} weekly downloads)`}
          >
            <NpmIcon size={16} />
            <span>{NPM_DOWNLOADS}</span>
          </a>

          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="hero-box-light hero-nav-github"
          >
            <span>GitHub</span>
            <GithubIcon size={16} />
          </a>
        </nav>
      </header>

      <div className="hero-spacer" aria-hidden="true" />

      <div className="hero-content">
        <h1 id="hero-title" className="hero-heading">
          <span className="hero-heading-line">Liquid Glass</span>
          <span className="hero-heading-line">
            <span className="hero-heading-accent">everywhere</span>
            <br className="hero-mobile-break" />
            {' '}in your UI
          </span>
        </h1>

        <button
          type="button"
          className="hero-box-light hero-install-pill"
          onClick={handleCopyCommand}
          data-copied={copied ? 'true' : undefined}
          aria-label={`Copy install command: ${INSTALL_COMMAND}`}
        >
          <span className="hero-install-icon" aria-hidden="true">
            {copied ? <CheckIcon className="hero-copy-svg" /> : <CopyIcon className="hero-copy-svg" />}
          </span>
          <span className="hero-install-text">{INSTALL_COMMAND}</span>
          <span className="sr-only" aria-live="polite">
            {copied ? 'Copied npm install command to clipboard' : ''}
          </span>
        </button>
      </div>

      <footer className="hero-footer">
        <p className="hero-tagline">
          Support all modern browsers. Performance first. Zero dependencies.
        </p>
      </footer>
    </section>
  );
}
