import { useEffect, useRef, useState } from 'react'
import { useTypewriterText } from './useTypewriterText'
import Collapsible from './Collapsible'

interface Props {
  
  id: string
  text: string
  
  active: boolean
}

// 思考计时以消息 id 为键存放在组件外，避免切换对话时 ThinkingBlock 卸载/重挂
// 导致开始时间丢失、计时从头重来。同一 app 会话内 msg.id 稳定，故重挂后可续算。
interface ThinkTiming {
  startedAt: number
  
  doneMs?: number
}
const thinkTimings = new Map<string, ThinkTiming>()


export default function ThinkingBlock({ id, text, active }: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  // 是否自动跟随到底部：用户主动上滑离开底部则暂停跟随，滑回底部附近再恢复。
  const followBottomRef = useRef(true)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [doneSeconds, setDoneSeconds] = useState<number | null>(() => {
    const t = thinkTimings.get(id)
    return t?.doneMs != null ? Math.max(1, Math.round(t.doneMs / 1000)) : null
  })
  const visibleText = useTypewriterText(text, active)
  const clean = text.trim()
  const canExpand = clean.length > 0

  useEffect(() => {
    if (!active) return
    let timing = thinkTimings.get(id)
    if (!timing) {
      timing = { startedAt: Date.now() }
      thinkTimings.set(id, timing)
    }
    // 重新进入 active（例如续写）时清掉旧的完成态，继续从原始 startedAt 累加。
    timing.doneMs = undefined
    setDoneSeconds(null)

    const tick = (): void => {
      const t = thinkTimings.get(id)
      if (!t) return
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - t.startedAt) / 1000)))
    }
    tick()
    const timer = setInterval(tick, 500)
    return () => clearInterval(timer)
  }, [active, id])

  
  useEffect(() => {
    if (!active && !thinkTimings.has(id) && clean.length > 0) {
      thinkTimings.set(id, { startedAt: Date.now() })
    }
  }, [clean.length, active, id])

  useEffect(() => {
    if (active) return
    const timing = thinkTimings.get(id)
    if (timing) {
      // 首次结束时冻结用时；已冻结则沿用，避免重挂后用 now 重新计算导致数字跳变。
      if (timing.doneMs == null) timing.doneMs = Date.now() - timing.startedAt
      setDoneSeconds(Math.max(1, Math.round(timing.doneMs / 1000)))
    } else if (clean.length > 0) {
      setDoneSeconds((s) => s ?? 1)
    }
  }, [active, clean.length, id])

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
