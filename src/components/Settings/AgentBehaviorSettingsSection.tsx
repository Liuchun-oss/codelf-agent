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
      <SettingsGroup label="越狱模式（总开关）">
        <SettingsRow
          title="开启越狱模式"
          description="总开关。关闭时下面「清洗」「演练台」两栏全部不生效，行为与应用原版一致。开启即生效，无需任何额外配置：工具调用一律放行（连你配置的 deny 规则、PreToolUse hook 的拒绝一起旁路），允许读写工作区之外的任意路径，子 Agent 同样生效。每次调用仍写入审计日志。"
          control={
            <SettingsSwitch
              checked={settings.jailbreakMode}
              disabled={saving}
              onChange={(v) => {
                setSettings((s) => (s ? { ...s, jailbreakMode: v } : s))
                void save({ jailbreakMode: v })
              }}
            />
          }
        />
        {settings.jailbreakMode && (
          <div className="settings-inline-alert">
            越狱模式已开启：审批确认、deny 规则、hook 拦截与工作区路径限制全部失效，Agent
            会以你的账号权限直接操作本机。只在隔离环境或你完全信任的任务中使用。
          </div>
        )}
      </SettingsGroup>

      {settings.jailbreakMode && (
        <SettingsGroup label="├ 清洗（宿主层放行）">
          <SettingsRow
            title="当前状态：已清洗"
            description="审批门、工作区路径围栏、PreToolUse hook 的 deny、以及提示词里的审批/拒绝话术都已放开。这一栏不需要额外配置，也不需要你写任何提示词。"
            control={<span className="settings-actions-msg">生效中</span>}
          />
          <SettingsRow
            title="自定义系统提示词（可选，通常不用填）"
            description="留空即可：清洗开箱就是完整的。只有当你想把模型的身份/说话方式彻底换成自己写的一份时，才填这里；一旦填写，内置系统提示词会被你这段整体替换，动态运行时块也不再注入。"
            stacked
            control={
              <textarea
                rows={12}
                spellCheck={false}
                disabled={saving}
                placeholder="留空 = 使用内置的越狱版提示词（推荐，无需填写）。&#10;只有想彻底替换内置提示词时才在这里写。"
                value={settings.jailbreakSystemPrompt}
                onChange={(e) => {
                  const value = e.target.value
                  setSettings((s) => (s ? { ...s, jailbreakSystemPrompt: value } : s))
                }}
                onBlur={() => void save({ jailbreakSystemPrompt: settings.jailbreakSystemPrompt })}
              />
            }
          />
        </SettingsGroup>
      )}

      {settings.jailbreakMode && (
        <SettingsGroup label="└ 演练台（红队资产库）">
          <SettingsRow
            title="启用红队演练工具箱"
            description="开启后主 Agent 会挂上 57 个 redteam_* 工具（资产测绘/漏洞/凭据/WebShell/隧道/证据截图/攻击链/计分/POC 知识库/报告），额外暴露 5 个执行角色子 Agent，并追加指挥官提示词。数据按靶标分库存在本机 userData/redteam/，不碰工作区文件。"
            control={
              <SettingsSwitch
                checked={settings.redTeamEnabled}
                disabled={saving}
                onChange={(v) => {
                  setSettings((s) => (s ? { ...s, redTeamEnabled: v } : s))
                  void save({ redTeamEnabled: v })
                }}
              />
            }
          />
          {settings.redTeamEnabled && (
            <div className="settings-inline-alert">
              演练台只在授权范围内使用：你自有并管理的资产、有书面授权的评估，或离线靶场。对第三方系统的
              未授权扫描/入侵在多数地区属违法，范围由你负责。
            </div>
          )}
        </SettingsGroup>
      )}

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
        <SettingsRow
          title="工具/子 Agent 并行上限"
          description={`一轮内可同时执行的并行工具调用数，也决定同时并发运行的子 Agent 数量；范围 ${b.parallelToolLimit.min}-${b.parallelToolLimit.max}。超出部分会自动分批执行。`}
          control={
            <input
              type="number"
              min={b.parallelToolLimit.min}
              max={b.parallelToolLimit.max}
              disabled={saving}
              value={settings.parallelToolLimit}
              onChange={(e) =>
                setSettings((s) =>
                  s
                    ? { ...s, parallelToolLimit: clampInt(e.target.value, b.parallelToolLimit.min, b.parallelToolLimit.max, s.parallelToolLimit) }
                    : s
                )
              }
              onBlur={() => void save({ parallelToolLimit: settings.parallelToolLimit })}
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
