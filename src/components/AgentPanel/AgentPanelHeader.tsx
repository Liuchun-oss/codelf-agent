import { useEffect, useRef, useState } from 'react'
import { useAgentStore } from '@/stores/agentStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import ContextMenu, { type MenuItem } from '@/components/common/ContextMenu'
import { toast } from '@/stores/toastStore'
import ChatHistory from './ChatHistory'


export default function AgentPanelHeader(): JSX.Element {
  const streaming = useAgentStore((s) => s.streaming)
  const sessionStreaming = useAgentStore((s) => s.sessionStreaming)
  const sessionAttention = useAgentStore((s) => s.sessionAttention)
  const sessions = useAgentStore((s) => s.sessions)
  const openTabs = useAgentStore((s) => s.openTabs)
  const currentSessionId = useAgentStore((s) => s.currentSessionId)
  const newSession = useAgentStore((s) => s.newSession)
  const switchSession = useAgentStore((s) => s.switchSession)
  const closeSessionTab = useAgentStore((s) => s.closeSessionTab)
  const workspaceRoot = useWorkspaceStore((s) => s.workspace?.path)

  const [historyOpen, setHistoryOpen] = useState(false)
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  const historyBtnRef = useRef<HTMLButtonElement>(null)
  const tabsRef = useRef<HTMLDivElement>(null)
  const activeTabRef = useRef<HTMLDivElement>(null)

  // 在 IDE 模式下，只显示当前工作区的对话标签
  const filteredOpenTabs = workspaceRoot
    ? openTabs.filter((id) => {
        const session = sessions.find((s) => s.id === id)
        return session?.cwd === workspaceRoot
      })
    : openTabs

  const tabMetas = filteredOpenTabs
    .map((id) => sessions.find((s) => s.id === id))
    .filter(Boolean) as typeof sessions

  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [currentSessionId, tabMetas.length])

  const handleTabsWheel = (e: React.WheelEvent<HTMLDivElement>): void => {
    const el = tabsRef.current
    if (!el || e.deltaY === 0) return
    if (el.scrollWidth <= el.clientWidth) return
    el.scrollLeft += e.deltaY
  }

  const buildTabMenu = (id: string): MenuItem[] => {
    const tabStreaming = id === currentSessionId ? streaming : !!sessionStreaming[id]?.streaming
    return [
      {
        label: '复制对话ID',
        onClick: () => {
          void window.lc.clipboardWriteText(id)
          toast.info('对话ID已复制')
        }
      },
      { separator: true },
      {
        label: '关闭标签',
        disabled: tabStreaming,
        onClick: () => closeSessionTab(id)
      }
    ]
  }

  return (
    <header className="agent-panel-header">
      <div className="agent-panel-tabs" ref={tabsRef} onWheel={handleTabsWheel}>
        {tabMetas.map((meta) => {
          const active = meta.id === currentSessionId
          const tabStreaming = active ? streaming : !!sessionStreaming[meta.id]?.streaming
          const needsAttention = !active && !!sessionAttention[meta.id]
          return (
            <div
              key={meta.id}
              ref={active ? activeTabRef : undefined}
              role="tab"
              aria-selected={active}
              className={`agent-panel-tab${active ? ' active' : ''}${
                tabStreaming ? ' streaming' : ''
              }${needsAttention ? ' needs-attention' : ''}`}
              title={needsAttention ? `${meta.title}（需要你回应）` : meta.title}
              onClick={() => switchSession(meta.id)}
              onContextMenu={(e) => {
                e.preventDefault()
                setTabMenu({ x: e.clientX, y: e.clientY, id: meta.id })
              }}
            >
              <span className="agent-panel-tab-title">{meta.title}</span>
              {needsAttention && <span className="agent-panel-tab-attention" />}
              {tabStreaming && !needsAttention && <span className="agent-panel-tab-dot" />}
              <button
                type="button"
                className="agent-panel-tab-close"
                title={tabStreaming ? '生成中无法关闭' : '关闭标签'}
                aria-label="关闭标签"
                disabled={tabStreaming}
                onClick={(e) => {
                  e.stopPropagation()
                  closeSessionTab(meta.id)
                }}
              >
                ×
              </button>
            </div>
          )
        })}
      </div>
      <div className="agent-panel-header-actions">
        <button
          ref={historyBtnRef}
          type="button"
          className="agent-header-btn"
          title="对话历史"
          aria-label="对话历史"
          onClick={() => setHistoryOpen((v) => !v)}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M8 3.5V8l3 1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
            <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.3"/>
          </svg>
        </button>
        <button
          type="button"
          className="agent-header-btn"
          title="新建对话"
          aria-label="新建对话"
          onClick={() => newSession(workspaceRoot ?? null)}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          </svg>
        </button>
      </div>
      <ChatHistory
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        anchorRef={historyBtnRef}
        workspaceRoot={workspaceRoot ?? null}
      />
      {tabMenu && (
        <ContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          items={buildTabMenu(tabMenu.id)}
          onClose={() => setTabMenu(null)}
        />
      )}
    </header>
  )
}
