import { useState } from 'react'
import type { SessionQueue } from '@/stores/agentStore'

export interface MessageQueueBarProps {
  queue?: SessionQueue
  onRemove: (id: string) => void
  onClear: () => void
  onResume: () => void
}

function summarize(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 待发送队列条：显示 Agent 执行期间排队的用户消息。
 * 位于输入框上方——不遮挡消息流，也不与 composer 内的附件/图片区抢空间。
 */
export default function MessageQueueBar({ queue, onRemove, onClear, onResume }: MessageQueueBarProps): JSX.Element | null {
  const [collapsed, setCollapsed] = useState(false)

  if (!queue || queue.items.length === 0) return null

  const paused = queue.paused

  return (
    <div className={`agent-queue${paused ? ' paused' : ''}`} role="region" aria-label="待发送队列">
      <div className="agent-queue-head">
        <span className="agent-queue-title">
          {paused ? '队列已暂停' : '排队中'} · {queue.items.length} 条
        </span>
        <span className="agent-queue-hint">
          {paused ? '当前任务已停止，队列不会自动发出' : '当前任务结束后自动逐条发送'}
        </span>
        <div className="agent-queue-actions">
          {paused && (
            <button type="button" className="agent-queue-action primary" onClick={onResume}>
              继续发送
            </button>
          )}
          <button type="button" className="agent-queue-action" onClick={onClear}>
            清空
          </button>
          <button
            type="button"
            className="agent-queue-toggle"
            aria-expanded={!collapsed}
            title={collapsed ? '展开队列' : '收起队列'}
            onClick={() => setCollapsed((v) => !v)}
          >
            {collapsed ? '▸' : '▾'}
          </button>
        </div>
      </div>
      {!collapsed && (
        <ol className="agent-queue-list">
          {queue.items.map((item, index) => {
            const meta = [
              item.attachments && item.attachments.length > 0 ? `@${item.attachments.length}` : '',
              item.images && item.images.length > 0 ? `图 ${item.images.length}` : ''
            ]
              .filter(Boolean)
              .join(' · ')
            return (
              <li key={item.id} className="agent-queue-item">
                <span className="agent-queue-index">{index + 1}</span>
                <span className="agent-queue-text" title={item.text}>
                  {summarize(item.text)}
                </span>
                {meta && <span className="agent-queue-meta">{meta}</span>}
                <button
                  type="button"
                  className="agent-queue-remove"
                  aria-label="移除该条排队消息"
                  title="移除"
                  onClick={() => onRemove(item.id)}
                >
                  ×
                </button>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
