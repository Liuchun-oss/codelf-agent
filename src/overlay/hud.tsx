import React, { useEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import type { TakeoverStatus } from '@shared/takeoverTypes'
import './overlay.css'

const STATE_LABEL: Record<string, string> = {
  idle: '空闲',
  preparing: '准备中',
  running: '执行中',
  finishing: '收尾中',
  restoring: '恢复中'
}

const REASON_LABEL: Record<string, string> = {
  escape: '已按 ESC 退出',
  user: '已手动停止',
  watchdog: '超时自动结束',
  completed: '任务完成',
  error: '执行出错'
}

function Hud(): React.JSX.Element {
  const [status, setStatus] = useState<TakeoverStatus>({ state: 'preparing' })
  const [lines, setLines] = useState<string[]>([])
  const logRef = useRef<HTMLDivElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  // 标记下一段文本应另起新段（上一步操作后，新的思考另起一段，避免各步骤挤在一起）。
  const breakNext = useRef(false)

  useEffect(() => {
    const offStatus = window.lc.onTakeoverStatus((s) => setStatus(s))
    const offEvent = window.lc.onTakeoverEvent((ev) => {
      if (ev.kind === 'text' && ev.text) {
        setLines((prev) => {
          const next = [...prev]
          if (next.length === 0 || breakNext.current) {
            next.push('')
            breakNext.current = false
          }
          next[next.length - 1] += ev.text
          return next.slice(-100)
        })
      } else if (ev.kind === 'tool') {
        // 工具调用不展示内容，但用作段落分隔：下一段文本另起一行。
        breakNext.current = true
      } else if (ev.kind === 'error' && ev.text) {
        setLines((prev) => [...prev, `[错误] ${ev.text}`].slice(-100))
        breakNext.current = true
      }
    })
    return () => {
      offStatus()
      offEvent()
    }
  }, [])

  // 锁底：内容更新后滚到最新；并按内容自适应窗口高度（消除空白、保证 footer 不被挤掉）。
  useEffect(() => {
    const log = logRef.current
    const root = rootRef.current
    if (log) log.scrollTop = log.scrollHeight
    if (log && root) {
      // 非日志区高度（header+task+footer+padding）+ 日志完整内容高度 = 期望窗口高度。
      const fixed = root.clientHeight - log.clientHeight
      const desired = fixed + log.scrollHeight
      window.lc.takeoverResizeHud?.(desired)
    }
  }, [lines, status.task])

  const stopped = status.state === 'restoring' || status.state === 'finishing' || status.state === 'idle'
  const hasText = lines.some((l) => l.trim().length > 0)

  return (
    <div className="hud" ref={rootRef}>
      <div className="hud-header">
        <span className={`hud-dot ${status.state}`} />
        <span className="hud-title">
          Codelf 接管 · {STATE_LABEL[status.state] ?? status.state}
          {status.reason ? ` · ${REASON_LABEL[status.reason] ?? ''}` : ''}
        </span>
        <span className="hud-steps">{status.steps ? `第 ${status.steps} 步` : ''}</span>
      </div>
      {status.task && <div className="hud-task" title={status.task}>{status.task}</div>}
      {hasText ? (
        <div className="hud-log" ref={logRef}>
          {lines.map((l, i) => (
            <div key={i} className="hud-line">
              {l}
            </div>
          ))}
        </div>
      ) : (
        <div className="hud-empty">
          <span className="hud-spinner" />
          正在操作电脑…
        </div>
      )}
      <div className="hud-footer">
        <span className="hud-hint">按 ESC 退出控制</span>
        <button
          className="hud-stop"
          disabled={stopped}
          onClick={() => void window.lc.takeoverStop()}
        >
          停止
        </button>
      </div>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('hud-root') as HTMLElement).render(
  <React.StrictMode>
    <Hud />
  </React.StrictMode>
)
