import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useAgentStore, type SessionMeta } from '@/stores/agentStore'
import { useDialogStore } from '@/stores/dialogStore'
import { exportSessionToMarkdown, exportFileName } from './exportSession'
import { toast } from '@/stores/toastStore'

interface ChatHistoryProps {
  open: boolean
  onClose: () => void
  anchorRef: React.RefObject<HTMLElement | null>
  workspaceRoot: string | null
}

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

export default function ChatHistory({ open, onClose, anchorRef, workspaceRoot }: ChatHistoryProps): JSX.Element | null {
  const sessions = useAgentStore((s) => s.sessions)
  const currentSessionId = useAgentStore((s) => s.currentSessionId)
  const switchSession = useAgentStore((s) => s.switchSession)
  const deleteSession = useAgentStore((s) => s.deleteSession)
  const sessionMessages = useAgentStore((s) => s.sessionMessages)
  const messages = useAgentStore((s) => s.messages)
  const sessionStreaming = useAgentStore((s) => s.sessionStreaming)
  const streaming = useAgentStore((s) => s.streaming)

  const [search, setSearch] = useState('')
  const [menuId, setMenuId] = useState<string | null>(null)
  const [render, setRender] = useState(open)
  const [exiting, setExiting] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) {
      setRender(true)
      setExiting(false)
    } else if (render) {
      setExiting(true)
    }
  }, [open, render])

  useEffect(() => {
    if (!open) {
      setSearch('')
      setMenuId(null)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (panelRef.current?.contains(target)) return
      if (anchorRef.current?.contains(target)) return
      onClose()
    }
    setTimeout(() => document.addEventListener('mousedown', handler), 0)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, onClose, anchorRef])

  if (!render) return null

  // 在 IDE 模式下，只显示当前工作区的对话
  const filteredSessions = workspaceRoot
    ? sessions.filter((s) => s.cwd === workspaceRoot)
    : sessions

  const sorted = [...filteredSessions].sort((a, b) => b.updatedAt - a.updatedAt)
  const filtered = search.trim()
    ? sorted.filter((s) => s.title.toLowerCase().includes(search.toLowerCase()))
    : sorted

  const groups = groupByDate(filtered)

  const rect = anchorRef.current?.getBoundingClientRect()
  const top = rect ? rect.bottom + 4 : 40
  const right = rect ? window.innerWidth - rect.right : 8

  const onExport = async (id: string): Promise<void> => {
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
    setMenuId(null)
  }

  // 与首页/侧栏的删除入口保持一致：不可逆操作必须二次确认，生成中禁删
  const onDelete = async (id: string): Promise<void> => {
    setMenuId(null)
    const meta = sessions.find((m) => m.id === id)
    const ok = await useDialogStore.getState().confirm({
      title: '删除对话',
      message: `确定删除「${meta?.title ?? '对话'}」吗？删除后无法恢复。`,
      confirmText: '删除',
      danger: true
    })
    if (ok) deleteSession(id)
  }

  return createPortal(
    <div
      ref={panelRef}
      className={`chat-history-panel${exiting ? ' is-exiting' : ''}`}
      style={{ position: 'fixed', top, right, zIndex: 10000 }}
      onAnimationEnd={(e) => {
        if (exiting && e.currentTarget === e.target) {
          setRender(false)
          setExiting(false)
        }
      }}
    >
      <div className="chat-history-search">
        <input
          type="text"
          placeholder="搜索对话…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
        />
      </div>
      <div className="chat-history-list">
        {groups.map((group) => (
          <div key={group.label} className="chat-history-group">
            <div className="chat-history-group-label">{group.label}</div>
            {group.items.map((s) => (
              <div
                key={s.id}
                role="button"
                tabIndex={0}
                className={`chat-history-item${s.id === currentSessionId ? ' active' : ''}`}
                onClick={() => {
                  switchSession(s.id)
                  onClose()
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    switchSession(s.id)
                    onClose()
                  }
                }}
              >
                <span className="chat-history-item-title">{s.title}</span>
                {menuId === s.id ? (
                  <span className="chat-history-item-actions">
                    <button
                      type="button"
                      className="chat-history-action-btn"
                      onClick={(e) => {
                        e.stopPropagation()
                        void onExport(s.id)
                      }}
                      title="导出为 Markdown"
                    >
                      导出
                    </button>
                    <button
                      type="button"
                      className="chat-history-action-btn danger"
                      disabled={s.id === currentSessionId ? streaming : !!sessionStreaming[s.id]?.streaming}
                      onClick={(e) => {
                        e.stopPropagation()
                        void onDelete(s.id)
                      }}
                      title={
                        (s.id === currentSessionId ? streaming : !!sessionStreaming[s.id]?.streaming)
                          ? '生成中无法删除'
                          : '删除对话'
                      }
                    >
                      删除
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="chat-history-item-more"
                    aria-label="更多操作"
                    title="更多操作"
                    onClick={(e) => {
                      e.stopPropagation()
                      setMenuId(s.id)
                    }}
                  >
                    ···
                  </button>
                )}
              </div>
            ))}
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="chat-history-empty">
            {search.trim() ? '没有匹配的对话' : '还没有对话，点击「+」新建一个开始'}
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}
