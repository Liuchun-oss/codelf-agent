import { useEffect, useMemo, useState } from 'react'
import { useAgentStore } from '@/stores/agentStore'
import { deriveArtifacts, type Artifact, type ArtifactKind } from './artifacts'
import ArtifactView from './ArtifactView'

const KIND_LABEL: Record<ArtifactKind, string> = {
  web: '网页',
  runnable: '脚本',
  image: '图片',
  pdf: 'PDF',
  text: '文本',
  other: '文件'
}

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
  const [activePath, setActivePath] = useState<string | null>(null)

  // Keep a valid active tab: default to the latest artifact; if the active one
  // disappears (e.g. reverted), fall back to the last available.
  useEffect(() => {
    if (artifacts.length === 0) {
      if (activePath !== null) setActivePath(null)
      return
    }
    if (!activePath || !artifacts.some((a) => a.path === activePath)) {
      setActivePath(artifacts[artifacts.length - 1].path)
    }
  }, [artifacts, activePath])

  if (artifacts.length === 0) return null

  const active = artifacts.find((a) => a.path === activePath) ?? artifacts[artifacts.length - 1]

  return (
    <div className="artifact-panel">
      <div className="artifact-panel-head">
        <span className="artifact-panel-title">产物预览</span>
        <span className="artifact-panel-count">{artifacts.length}</span>
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
        {artifacts.map((a) => (
          <button
            key={a.path}
            type="button"
            role="tab"
            aria-selected={a.path === active.path}
            className={`artifact-tab${a.path === active.path ? ' active' : ''}`}
            title={a.path}
            onClick={() => setActivePath(a.path)}
          >
            <span className="artifact-tab-kind">{KIND_LABEL[a.kind]}</span>
            <span className="artifact-tab-name">{a.name}</span>
          </button>
        ))}
      </div>

      <div className="artifact-panel-body">
        <ArtifactView key={active.path} artifact={active} />
      </div>
    </div>
  )
}
