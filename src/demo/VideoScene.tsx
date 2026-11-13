import { useCallback, useEffect, useRef, useState } from 'react'
import { LiquidGlass, type LiquidGlassProps } from '../glass'

function Skip15Icon({ direction }: { direction: 'back' | 'forward' }) {
  const isBack = direction === 'back'
  return (
    <svg viewBox="0 0 36 36" className="video-skip-svg" aria-hidden="true">
      {isBack ? (
        <>
          <path
            d="M11.2 10.6A9.8 9.8 0 1 1 8.4 19.6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.1"
            strokeLinecap="round"
          />
          <path d="M12.2 7.2 7.7 10.4l4.5 2.9Z" fill="currentColor" />
        </>
      ) : (
        <>
          <path
            d="M24.8 10.6A9.8 9.8 0 1 0 27.6 19.6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.1"
            strokeLinecap="round"
          />
          <path d="M23.8 7.2 28.3 10.4l-4.5 2.9Z" fill="currentColor" />
        </>
      )}
      <text
        x="18"
        y="22.1"
        textAnchor="middle"
        fontSize="10.2"
        fontWeight="700"
        fill="currentColor"
        fontFamily="system-ui, -apple-system, sans-serif"
      >
        15
      </text>
    </svg>
  )
}

/**
 * Apple iOS 27 / visionOS floating Liquid Glass video player controls over live `<video>`.
 * `domSnapshot.ts` captures live video frames so every glass button and scrubber pill refracts motion in real time.
 */
export function VideoScene({ glass }: { glass: LiquidGlassProps }) {
  const stageRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const scrubberRef = useRef<HTMLDivElement>(null)
  const scrubbing = useRef<number | null>(null)

  const [playing, setPlaying] = useState(true)
  const [progress, setProgress] = useState(0.24)
  const [duration, setDuration] = useState(45)

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const sync = () => {
      const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 45
      setDuration(dur)
      setProgress(Math.min(1, Math.max(0, v.currentTime / dur)))
      setPlaying(!v.paused && !v.ended)
    }
    v.addEventListener('timeupdate', sync)
    v.addEventListener('loadedmetadata', sync)
    v.addEventListener('play', sync)
    v.addEventListener('pause', sync)
    v.addEventListener('seeked', sync)
    return () => {
      v.removeEventListener('timeupdate', sync)
      v.removeEventListener('loadedmetadata', sync)
      v.removeEventListener('play', sync)
      v.removeEventListener('pause', sync)
      v.removeEventListener('seeked', sync)
    }
  }, [])

  const togglePlay = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) {
      void v.play().catch(() => {})
      setPlaying(true)
    } else {
      v.pause()
      setPlaying(false)
    }
  }, [])

  const seekBy = useCallback(
    (delta: number) => {
      const v = videoRef.current
      if (!v) return
      const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : duration
      const next = Math.min(dur, Math.max(0, v.currentTime + delta))
      v.currentTime = next
      setProgress(next / dur)
    },
    [duration],
  )

  const seekToClientX = useCallback(
    (clientX: number) => {
      const bar = scrubberRef.current
      const v = videoRef.current
      if (!bar) return
      const rect = bar.getBoundingClientRect()
      if (rect.width <= 0) return
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
      setProgress(ratio)
      if (v) {
        const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : duration
        v.currentTime = ratio * dur
      }
    },
    [duration],
  )

  const onScrubDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    scrubbing.current = e.pointerId
    seekToClientX(e.clientX)
  }

  const onScrubMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (scrubbing.current !== e.pointerId) return
    seekToClientX(e.clientX)
  }

  const onScrubUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (scrubbing.current === e.pointerId) {
      scrubbing.current = null
    }
  }

  const playOrbGlass: LiquidGlassProps = {
    ...glass,
    refraction: Math.max(glass.refraction ?? 70, 72),
    depth: 52,
    frost: Math.min(glass.frost ?? 6, 8),
    lightIntensity: Math.max(glass.lightIntensity ?? 40, 48),
  }

  const skipOrbGlass: LiquidGlassProps = {
    ...glass,
    refraction: Math.max(glass.refraction ?? 70, 72),
    depth: 34,
    frost: Math.min(glass.frost ?? 6, 8),
    lightIntensity: Math.max(glass.lightIntensity ?? 40, 48),
  }

  const barGlass: LiquidGlassProps = {
    ...glass,
    refraction: Math.max(glass.refraction ?? 70, 58),
    depth: Math.min(Math.max(glass.depth ?? 30, 18), 22),
    frost: Math.max(glass.frost ?? 6, 10),
    lightIntensity: Math.max(glass.lightIntensity ?? 40, 44),
  }

  return (
    <section className="video-section" aria-labelledby="video-title">
      <div className="video-head">
        <div>
          <h2 id="video-title" className="video-title">
            Live Video &amp; Floating Liquid Controls
          </h2>
          <p className="video-sub">
            Playback orbs and the timeline scrubber refract live <code>&lt;video&gt;</code> frames in real time.
          </p>
        </div>
      </div>

      <div ref={stageRef} className="video-stage">
        <video
          ref={videoRef}
          className="video-media"
          src="/liquid-video.mp4"
          autoPlay
          loop
          muted
          playsInline
          onClick={togglePlay}
        />

        <div className="video-controls" data-lg-ignore="">
          <button
            type="button"
            className="video-orb video-orb--skip"
            aria-label="Rewind 15 seconds"
            onClick={() => seekBy(-15)}
          >
            <LiquidGlass mode="layer" refractionTarget={stageRef} {...skipOrbGlass} />
            <span className="video-orb-glyph">
              <Skip15Icon direction="back" />
            </span>
          </button>

          <button
            type="button"
            className="video-orb video-orb--play"
            aria-label={playing ? 'Pause video' : 'Play video'}
            aria-pressed={playing}
            onClick={togglePlay}
          >
            <LiquidGlass mode="layer" refractionTarget={stageRef} {...playOrbGlass} />
            <span className="video-orb-glyph">
              {playing ? (
                <svg viewBox="0 0 24 24" className="video-play-svg" aria-hidden="true">
                  <rect x="6" y="4.5" width="4.2" height="15" rx="1.6" fill="currentColor" />
                  <rect x="13.8" y="4.5" width="4.2" height="15" rx="1.6" fill="currentColor" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" className="video-play-svg video-play-svg--tri" aria-hidden="true">
                  <path d="M7 4.8a1.2 1.2 0 0 1 1.84-1.01l11.2 7.2a1.2 1.2 0 0 1 0 2.02l-11.2 7.2A1.2 1.2 0 0 1 7 19.2Z" fill="currentColor" />
                </svg>
              )}
            </span>
          </button>

          <button
            type="button"
            className="video-orb video-orb--skip"
            aria-label="Forward 15 seconds"
            onClick={() => seekBy(15)}
          >
            <LiquidGlass mode="layer" refractionTarget={stageRef} {...skipOrbGlass} />
            <span className="video-orb-glyph">
              <Skip15Icon direction="forward" />
            </span>
          </button>
        </div>

        <div
          ref={scrubberRef}
          data-lg-ignore=""
          className="video-scrubber"
          role="slider"
          tabIndex={0}
          aria-label="Seek video timeline"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(progress * duration)}
          onPointerDown={onScrubDown}
          onPointerMove={onScrubMove}
          onPointerUp={onScrubUp}
          onPointerCancel={onScrubUp}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') {
              e.preventDefault()
              seekBy(-5)
            } else if (e.key === 'ArrowRight') {
              e.preventDefault()
              seekBy(5)
            }
          }}
        >
          <LiquidGlass mode="layer" refractionTarget={stageRef} {...barGlass} />
          <div className="video-scrubber-track">
            <div className="video-scrubber-fill" style={{ width: `${(progress * 100).toFixed(2)}%` }} />
          </div>
        </div>
      </div>
    </section>
  )
}

