import { useState, useRef, useEffect } from 'react'
import { useAgentStore, type SessionMeta } from '@/stores/agentStore'
import { useDialogStore } from '@/stores/dialogStore'
import { exportSessionToMarkdown, exportFileName } from '@/components/AgentPanel/exportSession'
import { toast } from '@/stores/toastStore'

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

/** 按时间把会话分到 今天 / 昨天 / 最近 7 天 / 更早 四组（与 IDE 历史面板口径一致） */
function groupByDate(sessions: SessionMeta[]): { label: string; items: SessionMeta[] }[] {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterday = today - 86400000
  const weekAgo = today - 7 * 86400000

  const groups: { label: string; items: SessionMeta[] }[] = [
    { label: '今天', items: [] },
    { label: '昨天', items: [] },
    { label: '最近 7 天', items: [] },
    { label: '更早', items: [] }
  ]

  for (const s of sessions) {
    if (s.updatedAt >= today) groups[0].items.push(s)
    else if (s.updatedAt >= yesterday) groups[1].items.push(s)
    else if (s.updatedAt >= weekAgo) groups[2].items.push(s)
    else groups[3].items.push(s)
  }

  return groups.filter((g) => g.items.length > 0)
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

  const [menuId, setMenuId] = useState<string | null>(null)
  const [menuClosing, setMenuClosing] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  // 收起：先播退出动画，动画结束后再真正卸载（见 onActionsAnimEnd）
  const closeMenu = (): void => {
    setMenuClosing(true)
  }
  const onActionsAnimEnd = (e: React.AnimationEvent): void => {
    if (e.currentTarget !== e.target) return
    if (menuClosing) {
      setMenuId(null)
      setMenuClosing(false)
    }
  }

  // 点击菜单外部时收起展开的操作组
  useEffect(() => {
    if (!menuId) return
    const handler = (e: MouseEvent): void => {
      if (listRef.current?.contains(e.target as Node)) {
        const t = e.target as HTMLElement
        if (t.closest('.home-recent-actions') || t.closest('.home-recent-more')) return
      }
      closeMenu()
    }
    setTimeout(() => document.addEventListener('mousedown', handler), 0)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuId])

  const copyId = (id: string): void => {
    void window.lc.clipboardWriteText(id)
    toast.info('对话ID已复制')
    closeMenu()
  }

  const onExport = async (id: string): Promise<void> => {
    closeMenu()
    const meta = sessions.find((m) => m.id === id)
    if (!meta) return
    const msgs = id === currentSessionId ? messages : (sessionMessages[id] ?? [])
    const md = exportSessionToMarkdown(meta.title, msgs)
    try {
      const res = await window.lc.saveFileAs(exportFileName(meta.title), md)
      if (res.ok) toast.info('对话已导出')
      else if (res.error) toast.error(res.error)
    } catch {
      toast.error('导出失败')
    }
  }

  // 删除是不可逆操作，必须二次确认
  const confirmDelete = async (id: string, title: string): Promise<void> => {
    closeMenu()
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
  const groups = groupByDate(visible)

  const renderItem = (meta: SessionMeta): JSX.Element => {
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
        {menuId === meta.id ? (
          <span
            className={`home-recent-actions${menuClosing ? ' closing' : ''}`}
            onAnimationEnd={onActionsAnimEnd}
          >
            <button
              type="button"
              className="home-recent-action-btn"
              title="复制对话ID"
              onClick={(e) => {
                e.stopPropagation()
                copyId(meta.id)
              }}
            >
              复制ID
            </button>
            <button
              type="button"
              className="home-recent-action-btn"
              title="导出为 Markdown"
              onClick={(e) => {
                e.stopPropagation()
                void onExport(meta.id)
              }}
            >
              导出
            </button>
            <button
              type="button"
              className="home-recent-action-btn danger"
              title={isStreaming ? '生成中无法删除' : '删除对话'}
              disabled={isStreaming}
              onClick={(e) => {
                e.stopPropagation()
                void confirmDelete(meta.id, meta.title)
              }}
            >
              删除
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="home-recent-more"
            aria-label="更多操作"
            title="更多操作"
            onClick={(e) => {
              e.stopPropagation()
              setMenuId(meta.id)
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <circle cx="5" cy="12" r="1.6" />
              <circle cx="12" cy="12" r="1.6" />
              <circle cx="19" cy="12" r="1.6" />
            </svg>
          </button>
        )}
      </div>
    )
  }

  return (
    <div
      ref={listRef}
      className={sidebar ? 'home-recent-list home-recent-list--sidebar' : 'home-recent-list'}
    >
      {groups.map((group) => (
        <div key={group.label} className="home-recent-group">
          <div className="home-recent-group-label">{group.label}</div>
          {group.items.map((meta) => renderItem(meta))}
        </div>
      ))}
    </div>
  )
}
