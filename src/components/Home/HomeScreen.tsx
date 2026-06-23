import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useUiStore } from '@/stores/uiStore'
import { useAgentStore } from '@/stores/agentStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useDialogStore } from '@/stores/dialogStore'
import { toast } from '@/stores/toastStore'
import { addRecentWorkspace } from '@/utils/session'
import ConversationView from '@/components/AgentPanel/ConversationView'
import ArtifactPanel from '@/components/AgentPanel/ArtifactPanel'
import { deriveArtifacts } from '@/components/AgentPanel/artifacts'
import { useAppVersion } from '@/hooks/useAppVersion'
import CwdPicker from './CwdPicker'
import ModelPicker from './ModelPicker'
import RecentConversations from './RecentConversations'
import ResizeHandle from '@/components/common/ResizeHandle'

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

function greeting(): string {
  const h = new Date().getHours()
  if (h < 5) return '夜深了，做点什么？'
  if (h < 12) return '早上好，今天做点什么？'
  if (h < 18) return '下午好，今天做点什么？'
  return '晚上好，今天做点什么？'
}

const COMPOSER_MAX_HEIGHT = 220

/**
 * 对话壳（Codex 桌面版形态）：左侧常驻侧栏（新对话 + 对话列表 + 设置/IDE 入口），
 * 右侧主区在「新对话落地页」与「当前对话」之间切换——首页不再是独立页面。
 */
/**
 * 落地页底部自动接受复选框（与 AgentComposer 中保持一致）
 */
function HomeAutoAccept(): JSX.Element {
  const permissionMode = useAgentStore((s) => s.permissionMode)
  const setPermissionMode = useAgentStore((s) => s.setPermissionMode)
  return (
    <label
      className="home-composer-accept"
      title="自动接受文件修改和普通终端命令；危险操作仍需确认"
    >
      <input
        type="checkbox"
        checked={permissionMode === 'acceptEdits'}
        onChange={(e) => setPermissionMode(e.target.checked ? 'acceptEdits' : 'default')}
      />
      自动接受
    </label>
  )
}

export default function HomeScreen(): JSX.Element {
  const chatOpen = useUiStore((s) => s.homeChatOpen)
  const setChatOpen = useUiStore((s) => s.setHomeChatOpen)
  const sidebarOpen = useUiStore((s) => s.homeSidebarOpen)
  const setSidebarOpen = useUiStore((s) => s.setHomeSidebarOpen)
  const artifactOpen = useUiStore((s) => s.homeArtifactOpen)
  const setArtifactOpen = useUiStore((s) => s.setHomeArtifactOpen)
  const artifactWidth = useUiStore((s) => s.homeArtifactWidth)
  const setArtifactWidth = useUiStore((s) => s.setHomeArtifactWidth)
  const browserOpen = useUiStore((s) => s.homeBrowserOpen)
  const openHomeBrowser = useUiStore((s) => s.openHomeBrowser)
  const pickedWs = useUiStore((s) => s.homePickedWorkspace)
  const setPickedWs = useUiStore((s) => s.setHomePickedWorkspace)
  const [draft, setDraft] = useState('')
  const initializedPick = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const init = useAgentStore((s) => s.init)
  const newSession = useAgentStore((s) => s.newSession)
  const switchSession = useAgentStore((s) => s.switchSession)
  const sendMessage = useAgentStore((s) => s.sendMessage)
  const currentSessionId = useAgentStore((s) => s.currentSessionId)
  const sessions = useAgentStore((s) => s.sessions)
  const sessionMessages = useAgentStore((s) => s.sessionMessages)
  const messages = useAgentStore((s) => s.messages)
  const sessionCwd = useAgentStore(
    (s) => s.sessions.find((m) => m.id === s.currentSessionId)?.cwd ?? null
  )
  const hasProfile = useAgentStore((s) => !!s.activeProfile)

  // 当前对话里是否存在可预览产物（决定右侧预览栏是否出现）
  const hasArtifacts = useMemo(() => deriveArtifacts(messages).length > 0, [messages])

  // 是否存在“有内容”的历史对话（判定口径与左侧 RecentConversations 一致）
  const hasAnyConversation = sessions.some((m) => {
    const msgs = m.id === currentSessionId ? messages : sessionMessages[m.id]
    return !!msgs && msgs.length > 0
  })

  const lastWorkspace = useWorkspaceStore((s) => s.lastWorkspace)
  const workspace = useWorkspaceStore((s) => s.workspace)
  const appVersion = useAppVersion()

  useEffect(() => {
    init()
  }, [init])

  // 默认预选上次工作区（仅首次）
  useEffect(() => {
    if (initializedPick.current) return
    const preset = workspace ?? lastWorkspace
    if (preset) {
      setPickedWs(preset)
      initializedPick.current = true
    }
  }, [workspace, lastWorkspace])

  // 同步当前会话的 cwd 到 homePickedWorkspace（用于切换到 IDE 时使用正确的工作区）
  useEffect(() => {
    if (chatOpen && sessionCwd) {
      setPickedWs({ path: sessionCwd, name: basename(sessionCwd) })
    } else if (chatOpen && !sessionCwd) {
      setPickedWs(null)
    }
  }, [chatOpen, sessionCwd, setPickedWs])

  // 左侧没有任何历史对话时，右侧默认回到”新对话”落地页（例如把历史全部删除后），
  // 避免停留在一个已清空的对话视图上。
  useEffect(() => {
    if (chatOpen && !hasAnyConversation) setChatOpen(false)
  }, [chatOpen, hasAnyConversation, setChatOpen])

  // 落地页 composer 即聚焦，到手即可打字
  useEffect(() => {
    if (!chatOpen) textareaRef.current?.focus()
  }, [chatOpen])

  // 输入框随内容自动长高（封顶后内部滚动）
  const autoGrow = useCallback((): void => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT)}px`
    el.style.overflowY = el.scrollHeight > COMPOSER_MAX_HEIGHT ? 'auto' : 'hidden'
  }, [])

  // 对话中按 Esc 回到新对话落地页（设置/对话框打开时不抢）
  useEffect(() => {
    if (!chatOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (useUiStore.getState().showSettings) return
      if (useDialogStore.getState().active) return
      setChatOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [chatOpen, setChatOpen])

  const startChat = (): void => {
    const text = draft.trim()
    if (!text) return
    if (!hasProfile) {
      // 不静默跳转：说明原因，草稿保留，配置完成回来可直接发送
      toast.warn('尚未配置 AI Provider，请先在设置中添加；输入内容已保留')
      useUiStore.getState().setShowSettings(true)
      return
    }
    const cwd = pickedWs?.path ?? null
    newSession(cwd)
    if (pickedWs) addRecentWorkspace(pickedWs)
    void sendMessage(text)
    setDraft('')
    setChatOpen(true)
  }

  const openConversation = (sessionId: string): void => {
    switchSession(sessionId)
    setChatOpen(true)
    // 同步该对话的工作区到 homePickedWorkspace，这样切换 IDE 时会使用正确的工作区
    const session = sessions.find((s) => s.id === sessionId)
    if (session?.cwd) {
      setPickedWs({ path: session.cwd, name: basename(session.cwd) })
    } else {
      setPickedWs(null)
    }
  }

  return (
    <div className="home-screen">
      <div className="home-chat-layout">
        <aside
          className={`home-chat-sidebar${sidebarOpen ? '' : ' collapsed'}`}
          aria-hidden={!sidebarOpen}
        >
          <div className="home-chat-sidebar-inner">
            <div className="home-sidebar-top">
              <button
                type="button"
                className="home-chat-new"
                onClick={() => setChatOpen(false)}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 5v14M5 12h14" strokeLinecap="round" />
                </svg>
                新对话
              </button>
              <button
                type="button"
                className="home-icon-btn"
                title="收起侧栏"
                onClick={() => setSidebarOpen(false)}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <rect x="3" y="4" width="18" height="16" rx="1.5" />
                  <path d="M9 4v16" />
                </svg>
              </button>
            </div>
            <div className="home-chat-sidebar-scroll">
              <div className="home-sidebar-label">对话</div>
              <RecentConversations
                variant="sidebar"
                onOpen={openConversation}
                highlightCurrent={chatOpen}
              />
            </div>
            <div className="home-sidebar-footer">
              <button
                type="button"
                className="home-sidebar-action"
                title="设置"
                onClick={() => useUiStore.getState().setShowSettings(true)}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.08A1.7 1.7 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.08A1.7 1.7 0 0 0 20.91 10H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z" />
                </svg>
                设置
              </button>
              {appVersion && (
                <span className="home-sidebar-version" title={`版本 ${appVersion}`}>
                  v{appVersion}
                </span>
              )}
              </div>
          </div>
        </aside>

        <main className="home-main">
          {chatOpen ? (
            <div className="home-chat-split">
              <div className="home-chat-col">
                <div className="home-chat-header">
                  {!sidebarOpen && (
                    <button
                      type="button"
                      className="home-icon-btn"
                      title="展开侧栏"
                      onClick={() => setSidebarOpen(true)}
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                        <rect x="3" y="4" width="18" height="16" rx="1.5" />
                        <path d="M9 4v16" />
                      </svg>
                    </button>
                  )}
                  <span className="home-chat-cwd" title={sessionCwd ?? '未设置工作目录'}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                      <path d="M3 5.5A1.5 1.5 0 0 1 4.5 4h4l2 2.2h7A1.5 1.5 0 0 1 19 7.7v9.8A1.5 1.5 0 0 1 17.5 19h-13A1.5 1.5 0 0 1 3 17.5z" />
                    </svg>
                    {sessionCwd ?? '纯对话'}
                  </span>
                  {hasArtifacts && !artifactOpen && (
                    <button
                      type="button"
                      className="home-artifact-toggle"
                      title="展开产物预览"
                      onClick={() => setArtifactOpen(true)}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                        <rect x="3" y="4" width="18" height="16" rx="1.5" />
                        <path d="M14 4v16" />
                      </svg>
                      产物预览
                    </button>
                  )}
                  <button
                    type="button"
                    className="home-artifact-toggle"
                    title="打开内置浏览器"
                    onClick={() => {
                      openHomeBrowser()
                      setArtifactOpen(true)
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                      <circle cx="12" cy="12" r="9" />
                      <path d="M3 12h18M12 3c2.6 2.4 4 5.6 4 9s-1.4 6.6-4 9c-2.6-2.4-4-5.6-4-9s1.4-6.6 4-9z" />
                    </svg>
                    浏览器
                  </button>
                </div>
                <div className="home-chat-body agent-panel" key={currentSessionId}>
                  <ConversationView cwd={sessionCwd} autoFocus />
                </div>
              </div>
              {(hasArtifacts || browserOpen) && artifactOpen && (
                <div
                  className="home-artifact-pane"
                  style={{ flex: `0 0 ${artifactWidth}px`, width: artifactWidth }}
                >
                  <ResizeHandle
                    edge="left"
                    getSize={() => artifactWidth}
                    onResize={setArtifactWidth}
                    title="拖动调整预览宽度"
                  />
                  <ArtifactPanel onClose={() => setArtifactOpen(false)} />
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="home-chat-header">
                {!sidebarOpen && (
                  <button
                    type="button"
                    className="home-icon-btn"
                    title="展开侧栏"
                    onClick={() => setSidebarOpen(true)}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                      <rect x="3" y="4" width="18" height="16" rx="1.5" />
                      <path d="M9 4v16" />
                    </svg>
                  </button>
                )}
                <span className="home-chat-cwd" />
              </div>
              <div className="home-landing">
              <div className="home-hero">
                <h1 className="home-hero-title">{greeting()}</h1>
                {!hasProfile && (
                  <div className="home-setup-banner">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                      <circle cx="12" cy="12" r="9" />
                      <path d="M12 8v5" strokeLinecap="round" />
                      <circle cx="12" cy="16.5" r="0.6" fill="currentColor" stroke="none" />
                    </svg>
                    <span className="home-setup-banner-text">
                      还没有配置 AI 模型，配置后即可开始对话。
                    </span>
                    <button
                      type="button"
                      className="home-setup-banner-btn"
                      onClick={() => useUiStore.getState().setShowSettings(true)}
                    >
                      去添加模型
                    </button>
                  </div>
                )}
                <div className="home-composer">
                  <textarea
                    ref={textareaRef}
                    className="home-composer-input"
                    placeholder={hasProfile ? '描述你的任务，Enter 发送，Shift+Enter 换行' : '尚未配置 AI Provider，请先到「设置」添加'}
                    rows={2}
                    value={draft}
                    onChange={(e) => {
                      setDraft(e.target.value)
                      autoGrow()
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault()
                        startChat()
                      }
                    }}
                  />
                  <div className="home-composer-footer">
                    <div className="home-composer-pickers">
                      <CwdPicker value={pickedWs} onChange={setPickedWs} />
                      <ModelPicker />
                      <HomeAutoAccept />
                    </div>
                    <button
                      type="button"
                      className="home-composer-send"
                      title="开始对话 (Enter)"
                      disabled={!draft.trim()}
                      onClick={startChat}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                        <path d="M12 19V5M5 12l7-7 7 7" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            </div>
            </>
          )}
        </main>
      </div>
    </div>
  )
}
