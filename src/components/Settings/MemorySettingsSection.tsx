import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { MemorySettings } from '@shared/memoryTypes'
import { DEFAULT_MEMORY_SETTINGS } from '@shared/memoryTypes'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useAgentStore } from '@/stores/agentStore'
import { SettingsGroup, SettingsRow, SettingsSwitch } from './SettingsRow'

/** 解析当前可用的工作区根：优先 IDE 已打开的工作区，其次当前会话的 cwd。 */
function resolveWorkspaceRoot(): string | null {
  const ws = useWorkspaceStore.getState().workspace?.path
  if (ws) return ws
  const ag = useAgentStore.getState()
  return ag.sessions.find((m) => m.id === ag.currentSessionId)?.cwd ?? null
}

/** 取路径最后一段作为项目名（兼容 / 与 \\ 分隔，去掉结尾分隔符）。 */
function projectName(p: string | null): string {
  if (!p) return ''
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || p
}

export default function MemorySettingsSection(): JSX.Element {
  const [settings, setSettings] = useState<MemorySettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [hint, setHint] = useState<string | null>(null)

  // 内联编辑器状态
  const [editorOpen, setEditorOpen] = useState(false)
  const [editorPath, setEditorPath] = useState<string | null>(null)
  const [editorWorkspace, setEditorWorkspace] = useState<string | null>(null)
  const [editorContent, setEditorContent] = useState('')
  const [editorLoading, setEditorLoading] = useState(false)
  const [editorSaving, setEditorSaving] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    const s = await window.lc.aiGetMemorySettings()
    setSettings(s)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (patch: Partial<MemorySettings>): Promise<void> => {
    setSaving(true)
    try {
      const next = await window.lc.aiSaveMemorySettings(patch)
      setSettings(next)
    } finally {
      setSaving(false)
    }
  }

  const openProjectMemory = async (): Promise<void> => {
    const workspaceRoot = resolveWorkspaceRoot()
    if (!workspaceRoot) {
      setHint('未检测到工作区。请在 IDE 中打开项目，或在带工作目录的会话中操作（纯对话无项目记忆）。')
      return
    }
    setHint(null)
    setEditorLoading(true)
    setEditorOpen(true)
    setEditorWorkspace(workspaceRoot)
    try {
      const res = await window.lc.aiReadProjectMemory(workspaceRoot)
      if (!res.ok) {
        setHint('无法创建或读取项目记忆文件。')
        setEditorOpen(false)
        return
      }
      setEditorPath(res.path ?? null)
      setEditorContent(res.content ?? '')
    } catch (e) {
      setHint(e instanceof Error ? e.message : '读取失败。')
      setEditorOpen(false)
    } finally {
      setEditorLoading(false)
    }
  }

  const saveProjectMemory = async (): Promise<void> => {
    const workspaceRoot = resolveWorkspaceRoot()
    if (!workspaceRoot) {
      setHint('未检测到工作区，无法保存。')
      return
    }
    setEditorSaving(true)
    try {
      const res = await window.lc.aiWriteProjectMemory(workspaceRoot, editorContent)
      if (!res.ok) {
        setHint(`保存失败：${res.reason ?? '未知原因'}`)
        return
      }
      setEditorOpen(false)
      setHint('项目记忆已保存。')
    } finally {
      setEditorSaving(false)
    }
  }

  if (!settings) {
    return (
      <div className="settings-section-page">
        <div className="settings-inline-alert">加载中…</div>
      </div>
    )
  }

  return (
    <div className="settings-section-page">
      <SettingsGroup label="长期记忆">
        <SettingsRow
          title="启用长期记忆"
          description="跨会话记住项目知识与用户偏好。关闭后不注入也不写入记忆。"
          control={
            <SettingsSwitch
              disabled={saving}
              checked={settings.enabled}
              onChange={(v) => void save({ enabled: v })}
            />
          }
        />
        <SettingsRow
          title="新会话自动注入"
          description="新会话首轮把项目/全局记忆摘要注入上下文（仅放在动态段，不影响提示词缓存命中）。"
          control={
            <SettingsSwitch
              disabled={saving || !settings.enabled}
              checked={settings.injectOnNewSession}
              onChange={(v) => void save({ injectOnNewSession: v })}
            />
          }
        />
        <SettingsRow
          title="注入预算（token）"
          description="注入记忆摘要的 token 上限，范围 500-32000，超出按节裁剪。"
          control={
            <input
              type="number"
              min={500}
              max={32000}
              disabled={saving || !settings.enabled}
              value={settings.injectBudgetTokens}
              onChange={(e) =>
                setSettings((s) =>
                  s ? { ...s, injectBudgetTokens: Number(e.target.value) || s.injectBudgetTokens } : s
                )
              }
              onBlur={() => void save({ injectBudgetTokens: settings.injectBudgetTokens })}
            />
          }
        />
        <SettingsRow
          title="结构化会话记忆（checkpoint）"
          description="上下文压缩时，把被丢弃的对话提取为结构化的会话 checkpoint（11 字段），供后续恢复。独立运行，不影响提示词缓存。"
          control={
            <SettingsSwitch
              disabled={saving || !settings.enabled}
              checked={settings.writerEnabled}
              onChange={(v) => void save({ writerEnabled: v })}
            />
          }
        />
        <SettingsRow
          title="任务完成自动提醒"
          description="当 Agent 完成复杂任务后（如多步调试、文件修改），自动提醒其记笔记（总结步骤、踩坑、验证结果）。Agent 仍可自主决定是否记录。"
          control={
            <SettingsSwitch
              disabled={saving || !settings.enabled}
              checked={settings.autoNoteReminder}
              onChange={(v) => void save({ autoNoteReminder: v })}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup label="项目记忆">
        <SettingsRow
          title="编辑项目记忆"
          description="编辑当前项目的 MEMORY.md（不存在则自动创建）。记录项目背景、规则、架构决策与稳定知识，新会话会自动加载。对话模式与 IDE 模式均可使用。"
          stacked
          control={
            <button type="button" className="btn-secondary" onClick={() => void openProjectMemory()}>
              创建 / 编辑 MEMORY.md
            </button>
          }
        />
        {hint && <div className="settings-inline-alert">{hint}</div>}
      </SettingsGroup>

      {editorOpen &&
        createPortal(
          <div className="memory-editor-overlay" role="dialog" aria-modal="true">
            <div className="memory-editor-modal">
              <div className="memory-editor-header">
                <span className="memory-editor-title">
                  项目记忆 · {projectName(editorWorkspace) || 'MEMORY.md'}
                </span>
                {editorWorkspace && (
                  <span className="memory-editor-path" title={editorPath ?? editorWorkspace}>
                    {editorWorkspace}
                  </span>
                )}
              </div>
              {editorLoading ? (
                <div className="settings-inline-alert">读取中…</div>
              ) : (
                <textarea
                  className="memory-editor-textarea"
                  spellCheck={false}
                  value={editorContent}
                  onChange={(e) => setEditorContent(e.target.value)}
                />
              )}
              <div className="memory-editor-actions">
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={editorSaving}
                  onClick={() => setEditorOpen(false)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={editorSaving || editorLoading}
                  onClick={() => void saveProjectMemory()}
                >
                  {editorSaving ? '保存中…' : '保存'}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

      <div className="settings-actions">
        <span className="settings-actions-msg">{saving ? '保存中…' : '已同步'}</span>
        <button
          type="button"
          className="btn-secondary"
          disabled={saving}
          onClick={() => void save({ ...DEFAULT_MEMORY_SETTINGS })}
        >
          恢复记忆默认
        </button>
      </div>
    </div>
  )
}
