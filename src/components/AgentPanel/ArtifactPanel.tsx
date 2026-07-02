import { useEffect, useMemo, useState } from 'react'
import { useAgentStore } from '@/stores/agentStore'
import { useUiStore } from '@/stores/uiStore'
import { useVideoQueueStore } from '@/stores/videoQueueStore'
import { useHomeTerminalStore } from '@/stores/homeTerminalStore'
import { deriveArtifacts, type Artifact, type ArtifactKind } from './artifacts'
import ArtifactView from './ArtifactView'
import VideoQueueView from './VideoQueueView'
import BrowserView from '@/components/common/BrowserView'
import XtermView from '@/components/Terminal/XtermView'
import PopoverMenu, { type PopoverMenuItem } from '@/components/common/PopoverMenu'

const KIND_LABEL: Record<ArtifactKind, string> = {
  web: '网页',
  runnable: '脚本',
  image: '图片',
  pdf: 'PDF',
  text: '文本',
  other: '文件'
}

const BROWSER_TAB_PATH = '__browser__'
const VIDEO_QUEUE_TAB_PATH = '__video_queue__'
const TERMINAL_TAB_PREFIX = '__terminal__:'

interface Props {
  onClose?: () => void
}

/**
 * Right-hand artifact preview panel: one tab per previewable artifact in the
 * current conversation. Web artifacts render live; scripts run inline; images
 * / text / pdf render directly; anything else offers open-in-default-app.
 * A trailing “+” lets the user open extra browser or terminal tabs on demand.
 */
export default function ArtifactPanel({ onClose }: Props): JSX.Element | null {
  const messages = useAgentStore((s) => s.messages)
  const currentSessionId = useAgentStore((s) => s.currentSessionId)
  const sessionCwd = useAgentStore(
    (s) => s.sessions.find((m) => m.id === s.currentSessionId)?.cwd ?? null
  )
  const allArtifacts = useMemo<Artifact[]>(() => deriveArtifacts(messages), [messages])
  const dismissed = useUiStore((s) => s.dismissedArtifacts)
  const dismissArtifact = useUiStore((s) => s.dismissArtifact)
  const artifacts = useMemo<Artifact[]>(
    // 仅当签名与关闭时一致才隐藏；同路径重新写入（签名变化）会自动恢复显示。
    () => allArtifacts.filter((a) => dismissed[a.path] !== a.sig),
    [allArtifacts, dismissed]
  )
  const browserOpen = useUiStore((s) => s.homeBrowserOpen)
  const browserUrl = useUiStore((s) => s.homeBrowserUrl)
  const closeHomeBrowser = useUiStore((s) => s.closeHomeBrowser)
  const setHomeBrowserUrl = useUiStore((s) => s.setHomeBrowserUrl)
  const activeTab = useUiStore((s) => s.homeArtifactActiveTab)
  const setActiveTab = useUiStore((s) => s.setHomeArtifactActiveTab)
  const allVideoTasks = useVideoQueueStore((s) => s.tasks)
  const loadVideoTasks = useVideoQueueStore((s) => s.load)

  const allTerminals = useHomeTerminalStore((s) => s.sessions)
  const createTerminal = useHomeTerminalStore((s) => s.createSession)
  const closeTerminal = useHomeTerminalStore((s) => s.closeSession)
  const terminals = useMemo(
    () => allTerminals.filter((t) => t.sessionId === currentSessionId),
    [allTerminals, currentSessionId]
  )

  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null)

  // 仅展示归属于当前对话的视频任务，避免在无关对话里弹出/回退到视频队列。
  const videoTasks = useMemo(
    () => allVideoTasks.filter((t) => t.sessionId === currentSessionId),
    [allVideoTasks, currentSessionId]
  )
  const hasVideoQueue = videoTasks.length > 0
  const videoActiveCount = videoTasks.filter((t) => t.status === 'queued' || t.status === 'running').length

  // 进入主界面即加载/订阅视频队列，保证后台任务状态实时同步到面板。
  useEffect(() => {
    void loadVideoTasks()
  }, [loadVideoTasks])

  const terminalPath = (id: string): string => `${TERMINAL_TAB_PREFIX}${id}`
  const isTerminalTab = (tab: string | null): boolean => !!tab && tab.startsWith(TERMINAL_TAB_PREFIX)

  // 激活标签的「有效值」：store 为唯一来源。指向浏览器/视频/终端/已存在产物时直接采用；
  // 否则（null 或指向已消失的标签）回退到最后一个产物标签，再不行回退到其它已开标签。
  const fallbackTab = useMemo<string | null>(() => {
    if (artifacts.length > 0) return artifacts[artifacts.length - 1].path
    if (browserOpen) return BROWSER_TAB_PATH
    if (terminals.length > 0) return terminalPath(terminals[terminals.length - 1].id)
    return hasVideoQueue ? VIDEO_QUEUE_TAB_PATH : null
  }, [artifacts, browserOpen, terminals, hasVideoQueue])

  const effectiveTab = useMemo<string | null>(() => {
    if (activeTab === BROWSER_TAB_PATH) return browserOpen ? BROWSER_TAB_PATH : fallbackTab
    if (activeTab === VIDEO_QUEUE_TAB_PATH) return hasVideoQueue ? VIDEO_QUEUE_TAB_PATH : fallbackTab
    if (isTerminalTab(activeTab)) {
      const id = activeTab!.slice(TERMINAL_TAB_PREFIX.length)
      return terminals.some((t) => t.id === id) ? activeTab : fallbackTab
    }
    if (activeTab && artifacts.some((a) => a.path === activeTab)) return activeTab
    return fallbackTab
  }, [activeTab, artifacts, browserOpen, terminals, hasVideoQueue, fallbackTab])

  const tabCount =
    artifacts.length + (browserOpen ? 1 : 0) + (hasVideoQueue ? 1 : 0) + terminals.length
  const showingBrowser = effectiveTab === BROWSER_TAB_PATH
  const showingVideoQueue = effectiveTab === VIDEO_QUEUE_TAB_PATH
  const activeTerminalId = isTerminalTab(effectiveTab)
    ? effectiveTab!.slice(TERMINAL_TAB_PREFIX.length)
    : null
  const active =
    artifacts.find((a) => a.path === effectiveTab) ??
    (showingBrowser || showingVideoQueue || activeTerminalId ? null : artifacts[artifacts.length - 1] ?? null)

  const openBrowserTab = (): void => {
    useUiStore.getState().openHomeBrowser()
  }
  const openTerminalTab = async (): Promise<void> => {
    const id = await createTerminal(currentSessionId, sessionCwd ?? undefined)
    if (id) setActiveTab(terminalPath(id))
  }

  const addMenuItems: PopoverMenuItem[] = [
    { label: '打开浏览器', onClick: openBrowserTab },
    { label: '打开终端', onClick: () => void openTerminalTab() }
  ]

  return (
    <div className="artifact-panel">
      <div className="artifact-panel-head">
        <span className="artifact-panel-title">工作台</span>
        <span className="artifact-panel-count">{tabCount}</span>
        <span className="artifact-panel-spacer" aria-hidden />
        {onClose && (
          <button type="button" className="artifact-panel-close" title="收起面板" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>

      <div className="artifact-panel-tabs" role="tablist">
        {browserOpen && (
          <button
            type="button"
            role="tab"
            aria-selected={showingBrowser}
            className={`artifact-tab${showingBrowser ? ' active' : ''}`}
            title="内置浏览器"
            onClick={() => setActiveTab(BROWSER_TAB_PATH)}
          >
            <span className="artifact-tab-kind">浏览器</span>
            <span className="artifact-tab-name">内置浏览器</span>
            <span
              className="artifact-tab-close"
              title="关闭浏览器标签"
              onClick={(e) => {
                e.stopPropagation()
                closeHomeBrowser()
                setActiveTab(fallbackTab)
              }}
            >
              ×
            </span>
          </button>
        )}
        {artifacts.map((a) => (
          <button
            key={a.path}
            type="button"
            role="tab"
            aria-selected={a.path === effectiveTab}
            className={`artifact-tab${a.path === effectiveTab ? ' active' : ''}`}
            title={a.path}
            onClick={() => setActiveTab(a.path)}
          >
            <span className="artifact-tab-kind">{KIND_LABEL[a.kind]}</span>
            <span className="artifact-tab-name">{a.name}</span>
            <span
              className="artifact-tab-close"
              title="关闭此产物标签"
              role="button"
              aria-label="关闭此产物标签"
              onClick={(e) => {
                e.stopPropagation()
                dismissArtifact(a.path, a.sig)
              }}
            >
              ×
            </span>
          </button>
        ))}
        {terminals.map((t) => {
          const path = terminalPath(t.id)
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={path === effectiveTab}
              className={`artifact-tab${path === effectiveTab ? ' active' : ''}`}
              title={t.cwd || t.title}
              onClick={() => setActiveTab(path)}
            >
              <span className="artifact-tab-kind">终端</span>
              <span className="artifact-tab-name">{t.title}</span>
              <span
                className="artifact-tab-close"
                title="关闭终端标签"
                onClick={(e) => {
                  e.stopPropagation()
                  void closeTerminal(t.id)
                  if (path === effectiveTab) setActiveTab(fallbackTab)
                }}
              >
                ×
              </span>
            </button>
          )
        })}
        {hasVideoQueue && (
          <button
            type="button"
            role="tab"
            aria-selected={showingVideoQueue}
            className={`artifact-tab${showingVideoQueue ? ' active' : ''}`}
            title="视频队列"
            onClick={() => setActiveTab(VIDEO_QUEUE_TAB_PATH)}
          >
            <span className="artifact-tab-kind">视频</span>
            <span className="artifact-tab-name">
              视频队列{videoActiveCount > 0 ? ` (${videoActiveCount})` : ''}
            </span>
          </button>
        )}
        <button
          type="button"
          className="artifact-tab-add"
          title="打开浏览器或终端"
          aria-label="打开浏览器或终端"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setAddMenu({ x: r.left, y: r.bottom + 4 })
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>

      <div className="artifact-panel-body">
        {/* 终端始终挂载（仅切换可见性），避免切标签时终端被卸载导致会话/输出丢失。 */}
        {terminals.map((t) => (
          <XtermView key={t.id} session={t} visible={t.id === activeTerminalId} />
        ))}
        {showingBrowser ? (
          <BrowserView initialUrl={browserUrl} onUrlChange={setHomeBrowserUrl} />
        ) : showingVideoQueue ? (
          <VideoQueueView />
        ) : activeTerminalId ? null : active ? (
          <ArtifactView key={active.path} artifact={active} />
        ) : (
          <div className="artifact-panel-empty">
            <p>暂无产物。</p>
            <p>点击右上角 + 打开浏览器或终端。</p>
          </div>
        )}
      </div>

      {addMenu && (
        <PopoverMenu
          x={addMenu.x}
          y={addMenu.y}
          items={addMenuItems}
          onClose={() => setAddMenu(null)}
        />
      )}
    </div>
  )
}
