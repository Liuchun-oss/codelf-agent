import { useState, useRef, useEffect } from 'react'
import { useAgentStore, type SessionMeta } from '@/stores/agentStore'
import { useDialogStore } from '@/stores/dialogStore'
import { exportSessionToMarkdown, exportFileName } from '@/components/AgentPanel/exportSession'
import Collapsible from '@/components/AgentPanel/Collapsible'
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

const NO_WORKSPACE_KEY = '__none__'

interface WorkspaceGroup {
  key: string
  name: string
  cwd: string | null
  items: SessionMeta[]
}

/** 按工作区（cwd）分组；无工作区的会话归到「纯对话」。组内按最近更新倒序，组间按各自最近会话倒序 */
function groupByWorkspace(sessions: SessionMeta[]): WorkspaceGroup[] {
  const map = new Map<string, WorkspaceGroup>()
  for (const s of sessions) {
    const key = s.cwd ?? NO_WORKSPACE_KEY
    let group = map.get(key)
    if (!group) {
      group = {
        key,
        name: s.cwd ? cwdName(s.cwd) ?? s.cwd : '纯对话',
        cwd: s.cwd,
        items: []
      }
      map.set(key, group)
    }
    group.items.push(s)
  }
  const groups = [...map.values()]
  for (const g of groups) g.items.sort((a, b) => b.updatedAt - a.updatedAt)
  return groups.sort((a, b) => (b.items[0]?.updatedAt ?? 0) - (a.items[0]?.updatedAt ?? 0))
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
  const archiveSession = useAgentStore((s) => s.archiveSession)
  const renameSession = useAgentStore((s) => s.renameSession)
  const sessionStreaming = useAgentStore((s) => s.sessionStreaming)
  const streaming = useAgentStore((s) => s.streaming)

  const [menuId, setMenuId] = useState<string | null>(null)
  const [menuClosing, setMenuClosing] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [query, setQuery] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
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

  const startRename = (meta: SessionMeta): void => {
    setRenamingId(meta.id)
    setRenameDraft(meta.title)
    // 不走 closeMenu 的退出动画：菜单收起动画期间 .home-recent-main 是 display:none，
    // 重命名输入框若在此时挂载，autoFocus 会失效
    setMenuId(null)
  }

  const commitRename = (id: string): void => {
    const trimmed = renameDraft.trim()
    if (trimmed) renameSession(id, trimmed)
    setRenamingId(null)
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

  const onArchive = (id: string, archived: boolean): void => {
    closeMenu()
    archiveSession(id, archived)
    toast.info(archived ? '对话已归档' : '已取消归档')
  }

  const hasContent = (id: string): boolean => {
    const msgs = id === currentSessionId ? messages : sessionMessages[id]
    return !!msgs && msgs.length > 0
  }

  const allWithContent = sessions
    .filter((m) => hasContent(m.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)

  const sidebar = variant === 'sidebar'

  if (allWithContent.length === 0) {
    return (
      <div className="home-recent-empty">
        {sidebar ? '暂无历史对话' : '还没有对话，从上方开始第一个任务吧。'}
      </div>
    )
  }

  const archivedCount = allWithContent.filter((m) => m.archived).length
  // 侧栏可切换查看归档；卡片形态始终只展示未归档对话
  const scoped = allWithContent.filter((m) => (sidebar && showArchived ? m.archived : !m.archived))

  // 当前会话所属的工作区分组（默认展开该组，其它组默认折叠）
  const currentMeta = sessions.find((m) => m.id === currentSessionId)
  const currentGroupKey = currentMeta ? currentMeta.cwd ?? NO_WORKSPACE_KEY : null

  const q = query.trim().toLowerCase()
  const visible = q ? scoped.filter((m) => m.title.toLowerCase().includes(q)) : scoped

  const dateGroups = groupByDate(visible)
  const wsGroups = groupByWorkspace(visible)
  const toggleCollapse = (key: string, current: boolean): void =>
    setCollapsed((prev) => ({ ...prev, [key]: !current }))

  const searchBox = sidebar ? (
    <div className="home-recent-search">
      <input
        type="text"
        placeholder="搜索标题…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {(archivedCount > 0 || showArchived) && (
        <button
          type="button"
          className={`home-recent-archived-toggle${showArchived ? ' active' : ''}`}
          onClick={() => setShowArchived((v) => !v)}
          title={showArchived ? '返回活跃对话' : '查看已归档对话'}
        >
          {showArchived ? '返回对话' : `已归档${archivedCount > 0 ? ` (${archivedCount})` : ''}`}
        </button>
      )}
    </div>
  ) : null

  const renderItem = (meta: SessionMeta, hideCwd = false): JSX.Element => {
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
        onClick={() => {
          if (renamingId === meta.id) return
          onOpen(meta.id)
        }}
        onKeyDown={(e) => {
          if (renamingId === meta.id) return
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onOpen(meta.id)
          }
        }}
      >
        <div className="home-recent-main">
          {renamingId === meta.id ? (
            <input
              className="home-recent-rename-input"
              value={renameDraft}
              autoFocus
              onChange={(e) => setRenameDraft(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.nativeEvent.isComposing) return
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commitRename(meta.id)
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  setRenamingId(null)
                }
              }}
              onBlur={() => commitRename(meta.id)}
            />
          ) : (
            <span className="home-recent-title">
              {isStreaming && <span className="home-recent-dot" title="进行中" />}
              {meta.title}
            </span>
          )}
          <span className="home-recent-meta">
            {dir && !hideCwd && (
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
              title="重命名对话"
              onClick={(e) => {
                e.stopPropagation()
                startRename(meta)
              }}
            >
              重命名
            </button>
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
              className="home-recent-action-btn"
              title={meta.archived ? '取消归档' : '归档对话'}
              onClick={(e) => {
                e.stopPropagation()
                onArchive(meta.id, !meta.archived)
              }}
            >
              {meta.archived ? '取消归档' : '归档'}
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
      {searchBox}
      {visible.length === 0 ? (
        <div className="home-recent-empty">
          {q ? '没有匹配的对话' : showArchived ? '没有已归档的对话' : '暂无活跃对话'}
        </div>
      ) : sidebar ? (
        wsGroups.map((group) => {
          // 未手动操作过的分组：当前会话所在工作区默认展开，其余默认折叠
          const defaultCollapsed = group.key !== currentGroupKey
          const isCollapsed = collapsed[group.key] ?? defaultCollapsed
          return (
            <div key={group.key} className="home-recent-ws-group">
              <button
                type="button"
                className="home-recent-ws-header"
                onClick={() => toggleCollapse(group.key, isCollapsed)}
                aria-expanded={!isCollapsed}
                title={group.cwd ?? '纯对话'}
              >
                <svg
                  className={`home-recent-ws-caret${isCollapsed ? '' : ' expanded'}`}
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  aria-hidden
                >
                  <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <svg
                  className="home-recent-ws-icon"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  aria-hidden
                >
                  <path d="M3 5.5A1.5 1.5 0 0 1 4.5 4h4l2 2.2h7A1.5 1.5 0 0 1 19 7.7v9.8A1.5 1.5 0 0 1 17.5 19h-13A1.5 1.5 0 0 1 3 17.5z" />
                </svg>
                <span className="home-recent-ws-name">{group.name}</span>
                <span className="home-recent-ws-count">{group.items.length}</span>
              </button>
              <Collapsible open={!isCollapsed}>
                <div className="home-recent-ws-items">
                  {group.items.map((meta) => renderItem(meta, true))}
                </div>
              </Collapsible>
            </div>
          )
        })
      ) : (
        dateGroups.map((group) => (
          <div key={group.label} className="home-recent-group">
            <div className="home-recent-group-label">{group.label}</div>
            {group.items.map((meta) => renderItem(meta))}
          </div>
        ))
      )}
    </div>
  )
}
