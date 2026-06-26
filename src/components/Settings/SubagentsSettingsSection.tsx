import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AgentDefinitionSummary, ProviderProfileSummary } from '@shared/agentTypes'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useAgentStore } from '@/stores/agentStore'
import { useEditorStore } from '@/stores/editorStore'
import { toast } from '@/stores/toastStore'
import { SettingsGroup, SettingsRow, SettingsSwitch } from './SettingsRow'

const SOURCE_LABEL: Record<AgentDefinitionSummary['source'], string> = {
  'built-in': '内置',
  project: '项目'
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/

interface DraftState {
  id: string
  title: string
  description: string
  readOnly: boolean
  model: string
  prompt: string
}

const EMPTY_DRAFT: DraftState = {
  id: '',
  title: '',
  description: '',
  readOnly: true,
  model: '',
  prompt: ''
}

function joinPath(root: string, ...segs: string[]): string {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  const trimmed = root.replace(/[\\/]+$/, '')
  return [trimmed, ...segs].join(sep)
}

function buildAgentMarkdown(draft: DraftState): string {
  const fm: string[] = ['---']
  fm.push(`title: ${draft.title.trim() || draft.id}`)
  fm.push(`description: ${draft.description.trim() || `项目子 Agent：${draft.id}`}`)
  fm.push(`readOnly: ${draft.readOnly ? 'true' : 'false'}`)
  if (draft.model.trim()) fm.push(`model: ${draft.model.trim()}`)
  fm.push('---')
  fm.push('')
  fm.push(draft.prompt.trim() || `你是「${draft.title.trim() || draft.id}」子 Agent。\n\n职责：\n- （描述这个子 Agent 要做的事）`)
  fm.push('')
  return fm.join('\n')
}

export default function SubagentsSettingsSection(): JSX.Element {
  const globalWorkspaceRoot = useWorkspaceStore((s) => s.workspace?.path ?? null)
  const sessionWorkspaceRoot = useAgentStore(
    (s) => s.sessions.find((m) => m.id === s.currentSessionId)?.cwd ?? null
  )
  const workspaceRoot = sessionWorkspaceRoot ?? globalWorkspaceRoot
  const openFile = useEditorStore((s) => s.openFile)
  const [defs, setDefs] = useState<AgentDefinitionSummary[]>([])
  const [profiles, setProfiles] = useState<ProviderProfileSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const list = await window.lc.aiListAgentDefinitions(workspaceRoot)
      setDefs(list)
    } finally {
      setLoading(false)
    }
  }, [workspaceRoot])

  useEffect(() => {
    void load()
    void window.lc
      .aiListProfiles()
      .then((list) => setProfiles(list))
      .catch(() => setProfiles([]))
  }, [load])

  const projectAgents = useMemo(() => defs.filter((d) => d.source === 'project'), [defs])
  const builtInAgents = useMemo(() => defs.filter((d) => d.source === 'built-in'), [defs])

  const existingIds = useMemo(() => new Set(defs.map((d) => d.id.toLowerCase())), [defs])

  const idError = useMemo(() => {
    const id = draft.id.trim()
    if (!id) return null
    if (!ID_PATTERN.test(id)) return '只能使用字母、数字、下划线或连字符，长度 1-80。'
    if (existingIds.has(id.toLowerCase())) return '已存在同名 Agent，换一个 id（项目级会覆盖同名内置）。'
    return null
  }, [draft.id, existingIds])

  const canSave = !!workspaceRoot && !!draft.id.trim() && !idError && !!draft.prompt.trim() && !busy

  const resetForm = (): void => {
    setDraft(EMPTY_DRAFT)
    setShowForm(false)
  }

  const handleCreate = async (): Promise<void> => {
    if (!workspaceRoot || !canSave) return
    setBusy(true)
    try {
      const id = draft.id.trim()
      const target = joinPath(workspaceRoot, '.codelf', 'agents', `${id}.md`)
      if (await window.lc.exists(target)) {
        toast.error(`文件已存在：${id}.md`)
        return
      }
      const ok = await window.lc.writeFile(target, buildAgentMarkdown(draft))
      if (!ok) {
        toast.error('创建子 Agent 失败')
        return
      }
      toast.info(`已创建子 Agent「${draft.title.trim() || id}」，主 Agent 可用 subagentType: "${id}" 调用`)
      resetForm()
      await load()
    } catch {
      toast.error('创建子 Agent 失败')
    } finally {
      setBusy(false)
    }
  }

  const handleEdit = async (agent: AgentDefinitionSummary): Promise<void> => {
    if (!agent.path) return
    const name = agent.path.split(/[\\/]/).pop() || `${agent.id}.md`
    await openFile(agent.path, name)
    toast.info('已在编辑器打开，修改保存后下一次调用即生效')
  }

  const handleDelete = async (agent: AgentDefinitionSummary): Promise<void> => {
    if (!agent.path) return
    if (!window.confirm(`确定删除子 Agent “${agent.title || agent.id}”？该操作会移除磁盘上的 ${agent.id}.md 文件，不可恢复。`)) {
      return
    }
    setBusy(true)
    try {
      const res = await window.lc.deleteItem(agent.path)
      if (!res?.ok) {
        toast.error(res?.error ?? '删除失败')
        return
      }
      toast.info('已删除子 Agent')
      await load()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-section-page">
      {workspaceRoot ? (
        <div className="settings-inline-alert">
          仅对当前工作区（<code>{workspaceRoot}</code>）生效。子 Agent 定义会保存在该项目的 <code>.codelf/agents/</code> 目录下。
        </div>
      ) : (
        <div className="settings-inline-alert">请先打开一个工作区，子 Agent 定义保存在工作区的 .codelf/agents/ 目录下。</div>
      )}

      <SettingsGroup label="项目子 Agent">
        {loading && <div className="settings-inline-alert">加载中…</div>}
        {!loading && projectAgents.length === 0 && (
          <div className="settings-inline-alert">
            还没有项目子 Agent。点下方“新建子 Agent”创建一个，主 Agent 会自动发现并能按 id 调度。
          </div>
        )}
        {projectAgents.map((agent) => (
          <div key={`project:${agent.id}`} className="skill-card">
            <div className="skill-card-info">
              <div className="skill-card-name">
                <span className="skill-card-title">{agent.title || agent.id}</span>
                <span className="settings-tag">{SOURCE_LABEL[agent.source]}</span>
                <span className="settings-tag">{agent.readOnly ? '只读' : '可写'}</span>
                <span className="settings-tag">id: {agent.id}</span>
                {agent.model && <span className="settings-tag">{agent.model}</span>}
              </div>
              <div className="skill-card-desc">{agent.description}</div>
            </div>
            <div className="skill-card-actions">
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => void handleEdit(agent)}>
                编辑
              </button>
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => void handleDelete(agent)}>
                删除
              </button>
            </div>
          </div>
        ))}
        <div className="settings-actions">
          <button
            type="button"
            className="btn"
            disabled={!workspaceRoot || busy || showForm}
            onClick={() => {
              setDraft(EMPTY_DRAFT)
              setShowForm(true)
            }}
          >
            新建子 Agent
          </button>
          <button type="button" className="btn-secondary" disabled={busy || loading} onClick={() => void load()}>
            刷新
          </button>
        </div>
      </SettingsGroup>

      {showForm && (
        <SettingsGroup label="新建子 Agent">
          <SettingsRow
            title="id（文件名）"
            description="作为 run_subagent 的 subagentType；只能用字母、数字、下划线、连字符。"
            stacked
            control={
              <input
                type="text"
                placeholder="例如 security-auditor"
                value={draft.id}
                disabled={busy}
                onChange={(e) => setDraft((d) => ({ ...d, id: e.target.value }))}
              />
            }
          />
          {idError && <div className="settings-inline-alert">{idError}</div>}
          <SettingsRow
            title="标题"
            description="显示名称，便于识别。"
            stacked
            control={
              <input
                type="text"
                placeholder="例如 安全审计员"
                value={draft.title}
                disabled={busy}
                onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
              />
            }
          />
          <SettingsRow
            title="描述"
            description="一句话说明它负责什么，主 Agent 据此判断何时调度它。"
            stacked
            control={
              <input
                type="text"
                placeholder="例如 专做安全审查，检查注入、越权、密钥泄露"
                value={draft.description}
                disabled={busy}
                onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              />
            }
          />
          <SettingsRow
            title="允许写入与执行命令"
            description="关闭则为只读（只能调查/分析/总结）；开启后才能改文件、跑命令，且仅在用户开启自动审批时生效。"
            control={
              <SettingsSwitch
                checked={!draft.readOnly}
                disabled={busy}
                onChange={(v) => setDraft((d) => ({ ...d, readOnly: !v }))}
              />
            }
          />
          <SettingsRow
            title="绑定模型"
            description="留空则用当前激活模型；也可指定一个已配置的 Provider。"
            control={
              <select
                value={draft.model}
                disabled={busy}
                onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
              >
                <option value="">默认（当前激活模型）</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.name}>
                    {p.name}（{p.model}）
                  </option>
                ))}
              </select>
            }
          />
          <SettingsRow
            title="人格 / 职责提示词"
            description="这个子 Agent 的系统提示词正文：定义它的身份、语气、职责与约束。"
            stacked
            control={
              <textarea
                rows={8}
                placeholder={'你是「安全审计员」子 Agent。\n\n职责：\n- 逐行审查代码里的注入、越权、密钥泄露等风险。\n\n约束：\n- 每条结论带 文件:行号 定位，只标真正的安全硬伤。'}
                value={draft.prompt}
                disabled={busy}
                onChange={(e) => setDraft((d) => ({ ...d, prompt: e.target.value }))}
              />
            }
          />
          <div className="settings-actions">
            <button type="button" className="btn" disabled={!canSave} onClick={() => void handleCreate()}>
              {busy ? '创建中…' : '创建'}
            </button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={resetForm}>
              取消
            </button>
          </div>
        </SettingsGroup>
      )}

      <SettingsGroup label="内置子 Agent（只读，不可修改）">
        {builtInAgents.map((agent) => (
          <div key={`built-in:${agent.id}`} className="skill-card">
            <div className="skill-card-info">
              <div className="skill-card-name">
                <span className="skill-card-title">{agent.title || agent.id}</span>
                <span className="settings-tag">{SOURCE_LABEL[agent.source]}</span>
                <span className="settings-tag">{agent.readOnly ? '只读' : '可写'}</span>
                <span className="settings-tag">id: {agent.id}</span>
              </div>
              <div className="skill-card-desc">{agent.description}</div>
            </div>
          </div>
        ))}
      </SettingsGroup>
    </div>
  )
}
