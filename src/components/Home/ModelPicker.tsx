import { useEffect, useRef, useState } from 'react'
import type { ProviderProfileSummary } from '@shared/agentTypes'
import { useAgentStore } from '@/stores/agentStore'

/** 模型选择器：列出已配置的 Provider profile，切换全局当前模型 */
export default function ModelPicker(): JSX.Element {
  const activeProfile = useAgentStore((s) => s.activeProfile)
  const refreshActiveProfile = useAgentStore((s) => s.refreshActiveProfile)
  const [open, setOpen] = useState(false)
  const [profiles, setProfiles] = useState<ProviderProfileSummary[]>([])
  const [switching, setSwitching] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    void window.lc.aiListProfiles().then((list) => {
      if (!cancelled) setProfiles(list)
    })
    return () => {
      cancelled = true
    }
  }, [activeProfile?.id])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const switchProfile = async (id: string): Promise<void> => {
    setOpen(false)
    if (!id || id === activeProfile?.id) return
    setSwitching(true)
    try {
      const res = await window.lc.aiSetActiveProfile(id)
      if (res.ok) await refreshActiveProfile()
    } finally {
      setSwitching(false)
    }
  }

  const label = activeProfile ? `${activeProfile.name} · ${activeProfile.model}` : '未配置模型'

  return (
    <div className="cwd-picker" ref={rootRef}>
      <button
        type="button"
        className="cwd-picker-trigger"
        title={label}
        disabled={switching}
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <rect x="4" y="5" width="16" height="14" rx="2" />
          <path d="M9 9h6M9 13h6" strokeLinecap="round" />
        </svg>
        <span className="cwd-picker-label">{label}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M6 9l6 6 6-6" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <div className="cwd-picker-menu">
          {profiles.length === 0 ? (
            <div className="cwd-picker-group">尚未配置模型，请到「设置」添加</div>
          ) : (
            profiles.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`cwd-picker-item${p.id === activeProfile?.id ? ' active' : ''}`}
                title={`${p.name} · ${p.model}`}
                onClick={() => void switchProfile(p.id)}
              >
                <span className="cwd-picker-item-name">{p.name}</span>
                <span className="cwd-picker-item-path">{p.model}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
