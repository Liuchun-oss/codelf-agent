import { useAgentStore } from '@/stores/agentStore'
import { useDialogStore } from '@/stores/dialogStore'

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  return new Date(ts).toLocaleDateString()
}

function cwdName(cwd: string | null): string | null {
  if (!cwd) return null
  const parts = cwd.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? cwd
}

interface RecentConversationsProps {
  onOpen: (sessionId: string) => void
  /** cards = 首页卡片列表；sidebar = 聊天视图左侧紧凑列表（高亮当前会话） */
  variant?: 'cards' | 'sidebar'
  /** 是否高亮当前会话；落地页（新对话）时应关闭，避免旧会话仍显示选中态 */
  highlightCurrent?: boolean
}

/** 全局最近对话列表（首页卡片 / 聊天侧栏两种形态共用） */
export default function RecentConversations({
  onOpen,
  variant = 'cards',
  highlightCurrent = true
}: RecentConversationsProps): JSX.Element {
  const sessions = useAgentStore((s) => s.sessions)
  const sessionMessages = useAgentStore((s) => s.sessionMessages)
  const currentSessionId = useAgentStore((s) => s.currentSessionId)
  const messages = useAgentStore((s) => s.messages)
  const deleteSession = useAgentStore((s) => s.deleteSession)
  const sessionStreaming = useAgentStore((s) => s.sessionStreaming)
  const streaming = useAgentStore((s) => s.streaming)

  // 删除是不可逆操作，必须二次确认
  const confirmDelete = async (id: string, title: string): Promise<void> => {
    const ok = await useDialogStore.getState().confirm({
      title: '删除对话',
      message: `确定删除「${title}」吗？删除后无法恢复。`,
      confirmText: '删除',
      danger: true
    })
    if (ok) deleteSession(id)
  }

  const hasContent = (id: string): boolean => {
    const msgs = id === currentSessionId ? messages : sessionMessages[id]
    return !!msgs && msgs.length > 0
  }

  const visible = sessions
    .filter((m) => hasContent(m.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)

  if (visible.length === 0) {
    return (
      <div className="home-recent-empty">
        {variant === 'sidebar' ? '暂无历史对话' : '还没有对话，从上方开始第一个任务吧。'}
      </div>
    )
  }

  const sidebar = variant === 'sidebar'

  return (
    <div className={sidebar ? 'home-recent-list home-recent-list--sidebar' : 'home-recent-list'}>
      {visible.map((meta) => {
        const isStreaming =
          meta.id === currentSessionId ? streaming : !!sessionStreaming[meta.id]?.streaming
        const dir = cwdName(meta.cwd)
        const active = sidebar && highlightCurrent && meta.id === currentSessionId
        return (
          <div
            key={meta.id}
            role="button"
            tabIndex={0}
            className={`home-recent-item${sidebar ? ' home-recent-item--sidebar' : ''}${active ? ' home-recent-item--active' : ''}`}
            onClick={() => onOpen(meta.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onOpen(meta.id)
              }
            }}
          >
            <div className="home-recent-main">
              <span className="home-recent-title">
                {isStreaming && <span className="home-recent-dot" title="进行中" />}
                {meta.title}
              </span>
              <span className="home-recent-meta">
                {dir && (
                  <span className="home-recent-cwd" title={meta.cwd ?? undefined}>
                    {dir}
                  </span>
                )}
                {!sidebar && (
                  <span className="home-recent-time">{formatRelativeTime(meta.updatedAt)}</span>
                )}
              </span>
            </div>
            <button
              type="button"
              className="home-recent-delete"
              title="删除对话"
              disabled={isStreaming}
              onClick={(e) => {
                e.stopPropagation()
                void confirmDelete(meta.id, meta.title)
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        )
      })}
    </div>
  )
}
