import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SubagentTaskSummary } from '@shared/agentTypes'
import { useAgentStore } from '@/stores/agentStore'
import { toast } from '@/stores/toastStore'

function formatAge(ts: number): string {
  const delta = Math.max(0, Date.now() - ts)
  if (delta < 60_000) return '刚刚'
  if (delta < 60 * 60_000) return `${Math.floor(delta / 60_000)} 分钟前`
  return `${Math.floor(delta / (60 * 60_000))} 小时前`
}

function formatDuration(ms: number | undefined): string | null {
  if (typeof ms !== 'number') return null
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function statusLabel(status: SubagentTaskSummary['status']): string {
  if (status === 'running') return '运行中'
  if (status === 'completed') return '完成'
  if (status === 'cancelled') return '已取消'
  return '失败'
}

export default function SubagentTaskManager(): JSX.Element {
  const currentSessionId = useAgentStore((s) => s.currentSessionId)
  const [open, setOpen] = useState(false)
  const [tasks, setTasks] = useState<SubagentTaskSummary[]>([])
  const rootRef = useRef<HTMLDivElement>(null)

  const runningCount = useMemo(() => tasks.filter((task) => task.status === 'running').length, [tasks])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await window.lc.aiListSubagentTasks(currentSessionId)
      setTasks(next)
    } catch {
      toast.error('读取后台子 Agent 任务失败')
    }
  }, [currentSessionId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  
  useEffect(() => {
    if (!open && runningCount === 0) return
    void refresh()
    const interval = open ? (runningCount > 0 ? 1500 : 2500) : 8000
    const timer = window.setInterval(() => void refresh(), interval)
    return () => window.clearInterval(timer)
  }, [open, refresh, runningCount])

  
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        // 关面板即消费 Esc，避免连带触发上层“退出对话”
        e.preventDefault()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const cancelTask = async (id: string): Promise<void> => {
    try {
      const ok = await window.lc.aiCancelSubagentTask(id)
      if (ok) toast.info('已取消后台子 Agent')
      else toast.warn('该后台子 Agent 已结束或不存在')
      await refresh()
    } catch {
      toast.error('取消后台子 Agent 失败')
    }
  }

  return (
    <div ref={rootRef} className={`subagent-task-manager${open ? ' open' : ''}`}>
      <button
        type="button"
        className="subagent-task-trigger"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="subagent-task-trigger-dot" />
        后台子 Agent
        {runningCount > 0 ? <span className="subagent-task-badge">{runningCount}</span> : null}
      </button>

      {open ? (
        <div className="subagent-task-popover" role="region" aria-label="后台子 Agent 任务">
          <div className="subagent-task-popover-head">
            <div>
              <div className="subagent-task-title">后台任务</div>
              <div className="subagent-task-subtitle">当前会话的异步子 Agent</div>
            </div>
          </div>

          {tasks.length === 0 ? (
            <div className="subagent-task-empty">还没有后台子 Agent。使用 runInBackground 后会出现在这里。</div>
          ) : (
            <div className="subagent-task-list">
              {tasks.slice(0, 8).map((task) => {
                const duration = formatDuration(task.durationMs)
                return (
                  <div key={task.id} className={`subagent-task-row ${task.status}`}>
                    <div className="subagent-task-main">
                      <div className="subagent-task-row-title" title={task.description}>{task.description}</div>
                      <div className="subagent-task-row-meta">
                        <span>{task.subagentType ?? 'readonly'}</span>
                        {task.model ? <span title={`模型：${task.model}`}>{task.model}</span> : null}
                        <span>{formatAge(task.updatedAt)}</span>
                        {duration ? <span>{duration}</span> : null}
                      </div>
                      {task.failureSummary ? <div className="subagent-task-failure">{task.failureSummary}</div> : null}
                    </div>
                    <div className="subagent-task-actions">
                      <span className={`subagent-task-status ${task.status}`}>{statusLabel(task.status)}</span>
                      {task.status === 'running' ? (
                        <button type="button" className="subagent-task-cancel" onClick={() => void cancelTask(task.id)}>
                          取消
                        </button>
                      ) : null}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}
