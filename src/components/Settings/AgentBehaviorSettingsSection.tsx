import { useCallback, useEffect, useState } from 'react'
import type { AgentBehaviorSettings } from '@shared/agentSettings'
import { AGENT_BEHAVIOR_BOUNDS, DEFAULT_AGENT_BEHAVIOR } from '@shared/agentSettings'
import type { KnowledgeBase } from '@/types'
import { SettingsGroup, SettingsRow, SettingsSwitch } from './SettingsRow'

function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function clampFloat(raw: string, min: number, max: number, fallback: number): number {
  const n = parseFloat(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n * 100) / 100))
}

export default function AgentBehaviorSettingsSection(): JSX.Element {
  const [settings, setSettings] = useState<AgentBehaviorSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [kbs, setKbs] = useState<KnowledgeBase[]>([])

  const load = useCallback(async (): Promise<void> => {
    const s = await window.lc.aiGetAgentSettings()
    setSettings(s)
  }, [])

  useEffect(() => {
    void load()
    void window.lc.knowledge
      .listKbs()
      .then((res) => {
        if (res.ok) setKbs(res.kbs)
      })
      .catch(() => {})
  }, [load])

  const save = async (patch: Partial<AgentBehaviorSettings>): Promise<void> => {
    setSaving(true)
    try {
      const next = await window.lc.aiSaveAgentSettings(patch)
      setSettings(next)
    } finally {
      setSaving(false)
    }
  }

  if (!settings) {
    return (
      <div className="settings-section-page">
        <div className="settings-inline-alert">加载中…</div>
      </div>
    )
  }

  const b = AGENT_BEHAVIOR_BOUNDS
  const maxTurnMinutes = Math.round(settings.maxTurnDurationMs / 60_000)

  return (
    <div className="settings-section-page">
      <SettingsGroup label="执行边界">
        <SettingsRow
          title="单轮最大工具步数"
          description={`范围 ${b.maxToolSteps.min}-${b.maxToolSteps.max}；填 0 表示不限制步数，仅受最长执行时间约束。`}
          control={
            <input
              type="number"
              min={b.maxToolSteps.min}
              max={b.maxToolSteps.max}
              disabled={saving}
              value={settings.maxToolSteps}
              onChange={(e) =>
                setSettings((s) =>
                  s
                    ? { ...s, maxToolSteps: clampInt(e.target.value, b.maxToolSteps.min, b.maxToolSteps.max, s.maxToolSteps) }
                    : s
                )
              }
              onBlur={() => void save({ maxToolSteps: settings.maxToolSteps })}
            />
          }
        />
        <SettingsRow
          title="单轮最长执行（分钟）"
          description="限制一次 Agent turn 的最长运行时间；填 0 表示不限制时间，仅受工具步数约束。"
          control={
            <input
              type="number"
              min={0}
              max={120}
              disabled={saving}
              value={maxTurnMinutes}
              onChange={(e) => {
                const minutes = clampInt(e.target.value, 0, 120, 20)
                setSettings((s) => (s ? { ...s, maxTurnDurationMs: minutes * 60_000 } : s))
              }}
              onBlur={() => void save({ maxTurnDurationMs: settings.maxTurnDurationMs })}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup label="延迟工具">
        <SettingsRow
          title="工具延迟策略"
          description="显式=仅延迟标记工具；自动=超过阈值后延迟非核心工具；非核心=始终延迟非核心工具。"
          control={
            <select
              disabled={saving}
              value={settings.deferredToolPolicy}
              onChange={(e) => {
                const value = e.target.value as AgentBehaviorSettings['deferredToolPolicy']
                setSettings((s) => (s ? { ...s, deferredToolPolicy: value } : s))
                void save({ deferredToolPolicy: value })
              }}
            >
              <option value="explicit">显式</option>
              <option value="auto">自动</option>
              <option value="non-core">非核心延迟</option>
            </select>
          }
        />
        <SettingsRow
          title="自动阈值字符数"
          description="auto 策略下，非核心工具定义超过该大小才启用延迟暴露。"
          control={
            <input
              type="number"
              min={b.deferredToolAutoThresholdChars.min}
              max={b.deferredToolAutoThresholdChars.max}
              disabled={saving || settings.deferredToolPolicy !== 'auto'}
              value={settings.deferredToolAutoThresholdChars}
              onChange={(e) =>
                setSettings((s) =>
                  s
                    ? {
                        ...s,
                        deferredToolAutoThresholdChars: clampInt(
                          e.target.value,
                          b.deferredToolAutoThresholdChars.min,
                          b.deferredToolAutoThresholdChars.max,
                          s.deferredToolAutoThresholdChars
                        )
                      }
                    : s
                )
              }
              onBlur={() => void save({ deferredToolAutoThresholdChars: settings.deferredToolAutoThresholdChars })}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup label="编辑应用">
        <SettingsRow
          title="Accept Edits 自动应用延迟（秒）"
          description="给用户保留观察与撤销窗口。"
          control={
            <input
              type="number"
              min={b.acceptEditsAutoApplyDelayMs.min / 1000}
              max={b.acceptEditsAutoApplyDelayMs.max / 1000}
              step={0.5}
              disabled={saving}
              value={settings.acceptEditsAutoApplyDelayMs / 1000}
              onChange={(e) => {
                const sec = parseFloat(e.target.value)
                const ms = Number.isFinite(sec)
                  ? Math.min(
                      b.acceptEditsAutoApplyDelayMs.max,
                      Math.max(b.acceptEditsAutoApplyDelayMs.min, Math.round(sec * 1000))
                    )
                  : settings.acceptEditsAutoApplyDelayMs
                setSettings((s) => (s ? { ...s, acceptEditsAutoApplyDelayMs: ms } : s))
              }}
              onBlur={() => void save({ acceptEditsAutoApplyDelayMs: settings.acceptEditsAutoApplyDelayMs })}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup label="知识库（RAG 自动注入）">
        <SettingsRow
          title="对话时自动检索知识库"
          description="每轮提问时用你的问题检索知识库，把最相关的文档片段注入到当前轮问题前的上下文区域（带来源标注）。"
          control={
            <SettingsSwitch
              checked={settings.knowledgeInjectEnabled}
              disabled={saving}
              onChange={(v) => {
                setSettings((s) => (s ? { ...s, knowledgeInjectEnabled: v } : s))
                void save({ knowledgeInjectEnabled: v })
              }}
            />
          }
        />
        <SettingsRow
          title="使用的知识库"
          description={kbs.length === 0 ? '尚无知识库，请先在「知识库」设置中创建并导入文档。' : '选择自动注入时检索的知识库。'}
          stacked
          control={
            <select
              disabled={saving || !settings.knowledgeInjectEnabled || kbs.length === 0}
              value={settings.knowledgeKbId}
              onChange={(e) => {
                const value = e.target.value
                setSettings((s) => (s ? { ...s, knowledgeKbId: value } : s))
                void save({ knowledgeKbId: value })
              }}
            >
              <option value="">最近创建的知识库</option>
              {kbs.map((kb) => (
                <option key={kb.id} value={kb.id}>
                  {kb.name}（{kb.docCount} 篇 / {kb.chunkCount} 块）
                </option>
              ))}
            </select>
          }
        />
        <SettingsRow
          title="注入片段数（topK）"
          description={`每轮注入的最相关片段数量，范围 ${b.knowledgeTopK.min}-${b.knowledgeTopK.max}。`}
          control={
            <input
              type="number"
              min={b.knowledgeTopK.min}
              max={b.knowledgeTopK.max}
              disabled={saving || !settings.knowledgeInjectEnabled}
              value={settings.knowledgeTopK}
              onChange={(e) =>
                setSettings((s) =>
                  s
                    ? { ...s, knowledgeTopK: clampInt(e.target.value, b.knowledgeTopK.min, b.knowledgeTopK.max, s.knowledgeTopK) }
                    : s
                )
              }
              onBlur={() => void save({ knowledgeTopK: settings.knowledgeTopK })}
            />
          }
        />
        <SettingsRow
          title="相似度下限"
          description={`只注入/返回相关度 ≥ 该值的片段（0–1，默认 ${DEFAULT_AGENT_BEHAVIOR.knowledgeMinScore}）。调高可减少无关内容，调低可提高召回。`}
          control={
            <input
              type="number"
              min={b.knowledgeMinScore.min}
              max={b.knowledgeMinScore.max}
              step={0.05}
              disabled={saving || !settings.knowledgeInjectEnabled}
              value={settings.knowledgeMinScore}
              onChange={(e) =>
                setSettings((s) =>
                  s
                    ? {
                        ...s,
                        knowledgeMinScore: clampFloat(
                          e.target.value,
                          b.knowledgeMinScore.min,
                          b.knowledgeMinScore.max,
                          s.knowledgeMinScore
                        )
                      }
                    : s
                )
              }
              onBlur={() => void save({ knowledgeMinScore: settings.knowledgeMinScore })}
            />
          }
        />
      </SettingsGroup>

      <div className="settings-actions">
        <span className="settings-actions-msg">{saving ? '保存中…' : '已同步'}</span>
        <button
          type="button"
          className="btn-secondary"
          disabled={saving}
          onClick={() => void save({ ...DEFAULT_AGENT_BEHAVIOR })}
        >
          恢复 Agent 默认
        </button>
      </div>
    </div>
  )
}
