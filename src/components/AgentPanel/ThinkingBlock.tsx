import { useEffect, useRef, useState } from 'react'
import { useTypewriterText } from './useTypewriterText'
import Collapsible from './Collapsible'

interface Props {
  text: string
  
  active: boolean
}


export default function ThinkingBlock({ text, active }: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const startedAtRef = useRef<number | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  // 是否自动跟随到底部：用户主动上滑离开底部则暂停跟随，滑回底部附近再恢复。
  const followBottomRef = useRef(true)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [doneSeconds, setDoneSeconds] = useState<number | null>(null)
  const visibleText = useTypewriterText(text, active)
  const clean = text.trim()
  const canExpand = clean.length > 0

  useEffect(() => {
    if (!active) return
    if (startedAtRef.current == null) startedAtRef.current = Date.now()
    setDoneSeconds(null)

    const tick = (): void => {
      if (startedAtRef.current == null) return
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAtRef.current) / 1000)))
    }
    tick()
    const timer = setInterval(tick, 500)
    return () => clearInterval(timer)
  }, [active])

  
  useEffect(() => {
    if (startedAtRef.current == null && doneSeconds == null && clean.length > 0) {
      startedAtRef.current = Date.now()
    }
  }, [clean.length, doneSeconds])

  useEffect(() => {
    if (active) return
    if (startedAtRef.current != null) {
      const ms = Date.now() - startedAtRef.current
      setDoneSeconds(Math.max(1, Math.round(ms / 1000)))
      startedAtRef.current = null
    } else if (clean.length > 0) {
      setDoneSeconds((s) => s ?? 1)
    }
  }, [active, clean.length])

  // 展开时重置为跟随底部（下次打开默认贴底）。
  useEffect(() => {
    if (open) followBottomRef.current = true
  }, [open])

  useEffect(() => {
    if (!open || !active || !bodyRef.current) return
    if (!followBottomRef.current) return
    bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [active, open, visibleText])

  // 用户滚动时更新跟随状态：贴近底部（阈值 24px）才继续自动跟随，上滑离开则暂停。
  const handleScroll = (): void => {
    const el = bodyRef.current
    if (!el) return
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    followBottomRef.current = distanceToBottom <= 24
  }

  return (
    <div className={`agent-thought${active ? ' active' : ''}${open ? ' open' : ''}`}>
      <button
        type="button"
        className="agent-thought-toggle"
        onClick={() => canExpand && setOpen((v) => !v)}
        disabled={!canExpand}
        aria-expanded={canExpand ? open : undefined}
      >
        <span className="agent-thought-chevron" aria-hidden>
          {canExpand ? (open ? '▾' : '▸') : ''}
        </span>
        {active ? (
          <span className="agent-thought-active">
            <span className="agent-thought-pulse" aria-hidden />
            <span className="agent-thought-text">思考中 · {elapsedSeconds}s</span>
            <span className="agent-thought-dots" aria-hidden>
              <span>.</span>
              <span>.</span>
              <span>.</span>
            </span>
          </span>
        ) : (
          <span className="agent-thought-done">思考了 {doneSeconds ?? 1} 秒</span>
        )}
      </button>
      <Collapsible open={open && canExpand}>
        <div
          ref={bodyRef}
          className={`agent-thought-body${active ? ' live' : ''}`}
          onScroll={handleScroll}
        >
          {visibleText}
        </div>
      </Collapsible>
    </div>
  )
}
