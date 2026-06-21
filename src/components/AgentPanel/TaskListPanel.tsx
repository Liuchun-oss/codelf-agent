import { useEffect, useState } from 'react'
import type { AgentTask } from '@shared/agentTypes'
import Collapsible from './Collapsible'

interface Props {
  tasks: AgentTask[]
  defaultCollapsed?: boolean
}

function statusText(status: AgentTask['status']): string {
  if (status === 'in_progress') return '进行中'
  if (status === 'completed') return '已完成'
  return '待处理'
}

function statusClass(status: AgentTask['status']): string {
  return `agent-task-status ${status.replace('_', '-')}`
}

function taskVerb(task: AgentTask): string {
  if (task.status === 'in_progress') return task.activeForm ?? task.subject
  return task.subject
}

export default function TaskListPanel({ tasks, defaultCollapsed = false }: Props): JSX.Element | null {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)

  useEffect(() => {
    if (defaultCollapsed) setCollapsed(true)
  }, [defaultCollapsed])

  if (tasks.length === 0) return null

  const completed = tasks.filter((t) => t.status === 'completed').length
  const pending = tasks.filter((t) => t.status === 'pending').length
  const inProgress = tasks.find((t) => t.status === 'in_progress')
  const allCompleted = completed === tasks.length
  const progress = Math.round((completed / tasks.length) * 100)
  const summaryText = allCompleted
    ? '全部任务已完成'
    : inProgress
      ? `正在${taskVerb(inProgress)}`
      : pending > 0
        ? `${pending} 项等待开始`
        : '等待下一项任务'
  const panelClass = [
    'agent-task-panel',
    allCompleted ? 'is-complete' : 'is-active',
    collapsed ? 'is-collapsed' : 'is-expanded'
  ].join(' ')
  const visible = [...tasks].sort((a, b) => {
    const rank = allCompleted
      ? ({ pending: 0, in_progress: 1, completed: 2 } as const)
      : ({ in_progress: 0, pending: 1, completed: 2 } as const)
    const ar = rank[a.status]
    const br = rank[b.status]
    if (ar !== br) return ar - br
    const an = Number.parseInt(a.id, 10)
    const bn = Number.parseInt(b.id, 10)
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn
    return a.id.localeCompare(b.id)
  })

  return (
    <section className={panelClass} aria-label="任务清单">
      <div className="agent-task-panel-glow" aria-hidden />
      <div className="agent-task-panel-head">
        <div className="agent-task-heading">
          <div className="agent-task-title-row">
            <span className="agent-task-title">任务清单</span>
            <span className="agent-task-count">
              已完成 {completed} / {tasks.length}
            </span>
          </div>
          <div className="agent-task-subtitle">
            {allCompleted ? '全部任务已完成。' : summaryText}
          </div>
        </div>
        <div className="agent-task-head-actions">
          <div className="agent-task-meter" aria-label={`已完成 ${completed} / ${tasks.length}`}>
            <svg viewBox="0 0 36 36" role="img" aria-hidden>
              <circle className="agent-task-meter-track" cx="18" cy="18" r="15.5" />
              <circle
                className="agent-task-meter-value"
                cx="18"
                cy="18"
                r="15.5"
                style={{ strokeDasharray: `${progress} 100` }}
              />
            </svg>
            <span>{progress}%</span>
          </div>
          <button
            type="button"
            className="agent-task-collapse-button"
            aria-expanded={!collapsed}
            aria-label={collapsed ? '展开任务清单' : '折叠任务清单'}
            onClick={() => setCollapsed((value) => !value)}
          >
            {collapsed ? '展开' : '收起'}
          </button>
        </div>
      </div>

      <div className="agent-task-progress" aria-hidden>
        <span style={{ width: `${progress}%` }} />
      </div>

      <Collapsible open={!collapsed}>
        <div className="agent-task-expanded">
          <div className="agent-task-list">
            {visible.map((task, index) => (
              <div key={task.id} className={`agent-task-row ${task.status.replace('_', '-')}`}>
                <span className="agent-task-check" aria-hidden />
                <span className="agent-task-body">
                  <span className="agent-task-subject">
                    {index + 1}. {task.subject}
                  </span>
                </span>
                <span className={statusClass(task.status)}>{statusText(task.status)}</span>
              </div>
            ))}
          </div>
        </div>
      </Collapsible>
    </section>
  )
}
