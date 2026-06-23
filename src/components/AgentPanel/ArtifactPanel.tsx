import { useMemo } from 'react'
import { useAgentStore } from '@/stores/agentStore'
import { useUiStore } from '@/stores/uiStore'
import { deriveArtifacts, type Artifact, type ArtifactKind } from './artifacts'
import ArtifactView from './ArtifactView'
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
  const artifacts = useMemo<Artifact[]>(() => deriveArtifacts(messages), [messages])
  const browserOpen = useUiStore((s) => s.homeBrowserOpen)
  const browserUrl = useUiStore((s) => s.homeBrowserUrl)
  const closeHomeBrowser = useUiStore((s) => s.closeHomeBrowser)
  const setHomeBrowserUrl = useUiStore((s) => s.setHomeBrowserUrl)
  const activeTab = useUiStore((s) => s.homeArtifactActiveTab)
  const setActiveTab = useUiStore((s) => s.setHomeArtifactActiveTab)

  // 激活标签的「有效值」：store 为唯一来源。store 指向浏览器/已存在产物时直接采用；
  // 否则（null 或指向已消失的产物）回退到最后一个产物标签，再不行回退到浏览器标签。
  const effectiveTab = useMemo<string | null>(() => {
    if (activeTab === BROWSER_TAB_PATH) return browserOpen ? BROWSER_TAB_PATH : (artifacts[artifacts.length - 1]?.path ?? null)
    if (activeTab && artifacts.some((a) => a.path === activeTab)) return activeTab
    if (artifacts.length > 0) return artifacts[artifacts.length - 1].path
    return browserOpen ? BROWSER_TAB_PATH : null
  }, [activeTab, artifacts, browserOpen])

  if (artifacts.length === 0 && !browserOpen) return null

  const tabCount = artifacts.length + (browserOpen ? 1 : 0)
  const showingBrowser = effectiveTab === BROWSER_TAB_PATH
  const active = artifacts.find((a) => a.path === effectiveTab) ?? (showingBrowser ? null : artifacts[artifacts.length - 1] ?? null)

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
          </button>
        ))}
      </div>

      <div className="artifact-panel-body">
        {showingBrowser ? (
          <BrowserView initialUrl={browserUrl} onUrlChange={setHomeBrowserUrl} />
        ) : active ? (
          <ArtifactView key={active.path} artifact={active} />
        ) : null}
      </div>
    </div>
  )
}
