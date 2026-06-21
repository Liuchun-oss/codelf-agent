import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SkillDetail, SkillInstallResult } from '@shared/skillTypes'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { SettingsGroup, SettingsRow, SettingsSwitch } from './SettingsRow'

const SOURCE_LABEL: Record<SkillDetail['source'], string> = {
  builtin: '内置',
  user: '用户',
  project: '项目'
}

interface TooltipState {
  skill: SkillDetail
  x: number
  y: number
}

function formatInstallResult(res: SkillInstallResult): string {
  if (!res.ok && res.error) return `导入失败：${res.error}`
  const parts: string[] = []
  if (res.installed && res.installed.length > 0) {
    parts.push(`已安装 ${res.installed.length} 个技能：${res.installed.map((s) => s.name).join(', ')}`)
  } else if (res.available && res.available.length > 0) {
    parts.push(`发现技能：${res.available.join(', ')}`)
  } else {
    parts.push('未发现可安装的技能')
  }
  if (res.errors && res.errors.length > 0) parts.push(`错误：${res.errors.join('；')}`)
  return parts.join('。')
}

export default function SkillsSettingsSection(): JSX.Element {
  const workspaceRoot = useWorkspaceStore((s) => s.workspace?.path ?? null)
  const [skills, setSkills] = useState<SkillDetail[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [source, setSource] = useState('')
  const [installMsg, setInstallMsg] = useState<string | null>(null)
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastPos = useRef<{ x: number; y: number }>({ x: 0, y: 0 })

  const clearHoverTimer = useCallback((): void => {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current)
      hoverTimer.current = null
    }
  }, [])

  const handleCardEnter = useCallback(
    (skill: SkillDetail, e: React.MouseEvent): void => {
      lastPos.current = { x: e.clientX, y: e.clientY }
      clearHoverTimer()
      hoverTimer.current = setTimeout(() => {
        setTooltip({ skill, x: lastPos.current.x, y: lastPos.current.y })
      }, 1000)
    },
    [clearHoverTimer]
  )

  const handleCardMove = useCallback((e: React.MouseEvent): void => {
    lastPos.current = { x: e.clientX, y: e.clientY }
  }, [])

  const handleCardLeave = useCallback((): void => {
    clearHoverTimer()
    setTooltip(null)
  }, [clearHoverTimer])

  useEffect(() => () => clearHoverTimer(), [clearHoverTimer])

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const list = await window.lc.skills.list(workspaceRoot)
      setSkills(list)
    } finally {
      setLoading(false)
    }
  }, [workspaceRoot])

  useEffect(() => {
    void load()
  }, [load])

  const handleToggle = async (skill: SkillDetail, enabled: boolean): Promise<void> => {
    setBusy(true)
    try {
      await window.lc.skills.setEnabled(skill.name, enabled)
      await load()
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (skill: SkillDetail): Promise<void> => {
    if (!window.confirm(`确定删除技能 “${skill.displayName || skill.name}”？该操作会移除磁盘上的文件，不可恢复。`)) {
      return
    }
    setBusy(true)
    try {
      const res = await window.lc.skills.remove(skill.name, skill.dir)
      if (!res.ok) setInstallMsg(res.error ?? '删除失败')
      await load()
    } finally {
      setBusy(false)
    }
  }

  const handleImport = async (): Promise<void> => {
    if (!source.trim()) return
    setBusy(true)
    setInstallMsg(null)
    try {
      const res = await window.lc.skills.install(source.trim())
      setInstallMsg(formatInstallResult(res))
      if (res.ok) setSource('')
      await load()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-section-page">
      <SettingsGroup label="已安装的技能">
        {loading && <div className="settings-inline-alert">加载中…</div>}
        {!loading && skills.length === 0 && (
          <div className="settings-inline-alert">尚未发现任何技能。通过下方的 Git 地址导入，或在工作区放置技能目录。</div>
        )}
        {skills.map((skill) => (
          <div
            key={`${skill.source}:${skill.name}`}
            className="skill-card"
            onMouseEnter={(e) => handleCardEnter(skill, e)}
            onMouseMove={handleCardMove}
            onMouseLeave={handleCardLeave}
          >
            <div className="skill-card-info">
              <div className="skill-card-name">
                <span className="skill-card-title">{skill.displayName || skill.name}</span>
                <span className="settings-tag">{SOURCE_LABEL[skill.source]}</span>
                {skill.version && <span className="settings-tag">v{skill.version}</span>}
                {!skill.enabled && <span className="settings-tag dot status-disabled">已禁用</span>}
              </div>
              <div className="skill-card-desc">{skill.description}</div>
            </div>
            <div className="skill-card-actions">
              <SettingsSwitch
                checked={skill.enabled}
                disabled={busy}
                onChange={(v) => void handleToggle(skill, v)}
              />
              {skill.deletable && (
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => void handleDelete(skill)}>
                  删除
                </button>
              )}
            </div>
          </div>
        ))}
        <div className="settings-actions">
          <button type="button" className="btn-secondary" disabled={busy || loading} onClick={() => void load()}>
            刷新
          </button>
        </div>
      </SettingsGroup>

      <SettingsGroup label="通过 Git 导入技能">
        <div className="skill-import">
          <SettingsRow
            title="来源地址"
            description="支持 owner/repo、完整 GitHub 链接、指向子目录的 /tree/ 链接，或任意 git 地址。需要本机已安装 git。"
            stacked
            control={
              <input
                type="text"
                placeholder="例如 anthropics/skills 或 https://github.com/owner/repo"
                disabled={busy}
                value={source}
                onChange={(e) => setSource(e.target.value)}
              />
            }
          />
          {installMsg && <div className="settings-inline-alert">{installMsg}</div>}
          <div className="skill-import-actions">
            <button type="button" className="btn" disabled={busy || !source.trim()} onClick={() => void handleImport()}>
              导入
            </button>
          </div>
        </div>
      </SettingsGroup>

      {tooltip &&
        createPortal(
          <div
            className="skill-tooltip-floating"
            role="tooltip"
            style={{ left: tooltip.x, top: tooltip.y }}
          >
            <div className="skill-tooltip-title">{tooltip.skill.displayName || tooltip.skill.name}</div>
            <div className="skill-tooltip-desc">{tooltip.skill.description}</div>
            {tooltip.skill.whenToUse && (
              <div className="skill-tooltip-when">何时使用：{tooltip.skill.whenToUse}</div>
            )}
          </div>,
          document.body
        )}
    </div>
  )
}
