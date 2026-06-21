import { useEffect, useRef, useState } from 'react'

const CHARS_PER_SECOND = 900
const MIN_CHARS_PER_SECOND = 120
const MAX_CHARS_PER_SECOND = 2600
const CATCH_UP_WINDOW = 600

export function useTypewriterText(text: string, streaming?: boolean): string {
  const [visible, setVisible] = useState(streaming ? '' : text)
  const visibleRef = useRef(streaming ? '' : text)
  const textRef = useRef(text)
  const rafRef = useRef<number | null>(null)
  const lastTsRef = useRef<number | null>(null)
  const everStreamedRef = useRef(!!streaming)

  if (streaming) everStreamedRef.current = true
  textRef.current = text

  useEffect(() => {
    if (!text.startsWith(visibleRef.current)) {
      visibleRef.current = ''
      setVisible('')
    }

    if (!everStreamedRef.current) {
      visibleRef.current = text
      setVisible(text)
      return
    }

    const stop = (): void => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      lastTsRef.current = null
    }

    if (visibleRef.current === text) return
    if (rafRef.current != null) return

    const tick = (ts: number): void => {
      const target = textRef.current
      const current = visibleRef.current
      const remaining = target.length - current.length

      if (remaining <= 0) {
        stop()
        return
      }

      if (lastTsRef.current == null) lastTsRef.current = ts
      const dt = Math.min(0.1, Math.max(0, (ts - lastTsRef.current) / 1000))
      lastTsRef.current = ts

      // The further behind we are, the faster we drain, so bursts catch up.
      const speed = Math.min(
        MAX_CHARS_PER_SECOND,
        Math.max(MIN_CHARS_PER_SECOND, CHARS_PER_SECOND + remaining * (CHARS_PER_SECOND / CATCH_UP_WINDOW))
      )
      const advance = Math.max(1, Math.round(speed * dt))
      const next = target.slice(0, Math.min(target.length, current.length + advance))

      visibleRef.current = next
      setVisible(next)

      if (next.length < target.length) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        stop()
      }
    }

    rafRef.current = requestAnimationFrame(tick)

    return stop
  }, [text, streaming])

  return visible
}
