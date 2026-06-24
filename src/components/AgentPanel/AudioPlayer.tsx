import { useEffect, useRef, useState } from 'react'

interface Props {
  src: string
  className?: string
}

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

// 主题化的音频播放器：替代浏览器原生 <audio controls>，保持与深色主题一致。
export default function AudioPlayer({ src, className }: Props): JSX.Element | null {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(0)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const el = audioRef.current
    if (!el) return
    const onTime = (): void => setCurrent(el.currentTime)
    const onLoaded = (): void => setDuration(el.duration)
    const onEnded = (): void => setPlaying(false)
    const onPlay = (): void => setPlaying(true)
    const onPause = (): void => setPlaying(false)
    el.addEventListener('timeupdate', onTime)
    el.addEventListener('loadedmetadata', onLoaded)
    el.addEventListener('durationchange', onLoaded)
    el.addEventListener('ended', onEnded)
    el.addEventListener('play', onPlay)
    el.addEventListener('pause', onPause)
    return () => {
      el.removeEventListener('timeupdate', onTime)
      el.removeEventListener('loadedmetadata', onLoaded)
      el.removeEventListener('durationchange', onLoaded)
      el.removeEventListener('ended', onEnded)
      el.removeEventListener('play', onPlay)
      el.removeEventListener('pause', onPause)
    }
  }, [src])

  if (failed) return null

  const toggle = (): void => {
    const el = audioRef.current
    if (!el) return
    if (el.paused) void el.play()
    else el.pause()
  }

  const seek = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const el = audioRef.current
    if (!el) return
    const t = Number(e.target.value)
    el.currentTime = t
    setCurrent(t)
  }

  const progress = duration > 0 ? (current / duration) * 100 : 0

  return (
    <div className={`audio-player${className ? ` ${className}` : ''}`}>
      <audio ref={audioRef} src={src} preload="metadata" onError={() => setFailed(true)} />
      <button
        type="button"
        className="audio-player-btn"
        onClick={toggle}
        aria-label={playing ? '暂停' : '播放'}
        title={playing ? '暂停' : '播放'}
      >
        {playing ? (
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
            <rect x="3.5" y="2.5" width="3" height="11" rx="1" />
            <rect x="9.5" y="2.5" width="3" height="11" rx="1" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
            <path d="M4.5 2.8c0-.6.66-.97 1.18-.66l7.2 4.7c.5.32.5 1.0 0 1.32l-7.2 4.7c-.52.34-1.18-.04-1.18-.66V2.8Z" />
          </svg>
        )}
      </button>
      <span className="audio-player-time">{formatTime(current)}</span>
      <input
        type="range"
        className="audio-player-seek"
        min={0}
        max={duration || 0}
        step={0.01}
        value={current}
        onChange={seek}
        style={{ '--audio-progress': `${progress}%` } as React.CSSProperties}
        aria-label="进度"
      />
      <span className="audio-player-time audio-player-duration">{formatTime(duration)}</span>
    </div>
  )
}
