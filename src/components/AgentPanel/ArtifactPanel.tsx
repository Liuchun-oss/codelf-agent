import { useEffect, useMemo } from 'react'
import { useAgentStore } from '@/stores/agentStore'
import { useUiStore } from '@/stores/uiStore'
import { useVideoQueueStore } from '@/stores/videoQueueStore'
import { deriveArtifacts, type Artifact, type ArtifactKind } from './artifacts'
import ArtifactView from './ArtifactView'
import VideoQueueView from './VideoQueueView'
import BrowserView from '@/components/common/BrowserView'

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

interface Props {
  onClose?: () => void
}

/**
 * Right-hand artifact preview panel: one tab per previewable artifact in the
 * current conversation. Web artifacts render live; scripts run inline; images
 * / text / pdf render directly; anything else offers open-in-default-app.
 */
export default function ArtifactPanel({ onClose }: Props): JSX.Element | null {
  const messages = useAgentStore((s) => s.messages)
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
  const videoTasks = useVideoQueueStore((s) => s.tasks)
  const loadVideoTasks = useVideoQueueStore((s) => s.load)
  const hasVideoQueue = videoTasks.length > 0
  const videoActiveCount = videoTasks.filter((t) => t.status === 'queued' || t.status === 'running').length

  // 进入主界面即加载/订阅视频队列，保证后台任务状态实时同步到面板。
  useEffect(() => {
    void loadVideoTasks()
  }, [loadVideoTasks])

  // 激活标签的「有效值」：store 为唯一来源。store 指向浏览器/视频队列/已存在产物时直接采用；
  // 否则（null 或指向已消失的产物）回退到最后一个产物标签，再不行回退到浏览器/视频队列标签。
  const effectiveTab = useMemo<string | null>(() => {
    if (activeTab === BROWSER_TAB_PATH) return browserOpen ? BROWSER_TAB_PATH : (artifacts[artifacts.length - 1]?.path ?? null)
    if (activeTab === VIDEO_QUEUE_TAB_PATH) return hasVideoQueue ? VIDEO_QUEUE_TAB_PATH : (artifacts[artifacts.length - 1]?.path ?? null)
    if (activeTab && artifacts.some((a) => a.path === activeTab)) return activeTab
    if (artifacts.length > 0) return artifacts[artifacts.length - 1].path
    if (browserOpen) return BROWSER_TAB_PATH
    return hasVideoQueue ? VIDEO_QUEUE_TAB_PATH : null
  }, [activeTab, artifacts, browserOpen, hasVideoQueue])

  if (artifacts.length === 0 && !browserOpen && !hasVideoQueue) return null

  const tabCount = artifacts.length + (browserOpen ? 1 : 0) + (hasVideoQueue ? 1 : 0)
  const showingBrowser = effectiveTab === BROWSER_TAB_PATH
  const showingVideoQueue = effectiveTab === VIDEO_QUEUE_TAB_PATH
  const active = artifacts.find((a) => a.path === effectiveTab) ?? (showingBrowser || showingVideoQueue ? null : artifacts[artifacts.length - 1] ?? null)

  return (
    <div className="artifact-panel">
      <div className="artifact-panel-head">
        <span className="artifact-panel-title">产物预览</span>
        <span className="artifact-panel-count">{tabCount}</span>
        <span className="artifact-panel-spacer" aria-hidden />
        {onClose && (
          <button type="button" className="artifact-panel-close" title="收起预览" onClick={onClose}>
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
                setActiveTab(artifacts[artifacts.length - 1]?.path ?? null)
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
      </div>

      <div className="artifact-panel-body">
        {showingBrowser ? (
          <BrowserView initialUrl={browserUrl} onUrlChange={setHomeBrowserUrl} />
        ) : showingVideoQueue ? (
          <VideoQueueView />
        ) : active ? (
          <ArtifactView key={active.path} artifact={active} />
        ) : null}
      </div>
    </div>
  )
}
