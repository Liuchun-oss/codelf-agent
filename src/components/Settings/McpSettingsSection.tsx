import { useCallback, useEffect, useState } from 'react'
import type {
  McpServerConfig,
  McpServerDetail,
  McpTransportType
} from '@shared/mcpTypes'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { DATA_DIR_NAME, PROJECT_MCP_FILE_NAME } from '@shared/appConfig'
import { SettingsGroup, SettingsRow, SettingsSwitch } from './SettingsRow'

const PROJECT_MCP_PATH = `${DATA_DIR_NAME}/${PROJECT_MCP_FILE_NAME}`

type TransportOption = McpTransportType

interface DraftState {
  name: string
  transport: TransportOption
  command: string
  args: string
  env: string
  url: string
  headers: string
}

const EMPTY_DRAFT: DraftState = {
  name: '',
  transport: 'stdio',
  command: '',
  args: '',
  env: '',
  url: '',
  headers: ''
}

function parseLines(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return out
}

function buildConfig(draft: DraftState): McpServerConfig | null {
  if (draft.transport === 'stdio') {
    if (!draft.command.trim()) return null
    const env = parseLines(draft.env)
    return {
      type: 'stdio',
      command: draft.command.trim(),
      args: draft.args
        .split('\n')
        .map((a) => a.trim())
        .filter(Boolean),
      env: Object.keys(env).length > 0 ? env : undefined
    }
  }
  if (!draft.url.trim()) return null
  const headers = parseLines(draft.headers)
  return {
    type: draft.transport,
    url: draft.url.trim(),
    headers: Object.keys(headers).length > 0 ? headers : undefined
  }
}

const STATUS_LABEL: Record<McpServerDetail['status'], string> = {
  connected: '已连接',
  connecting: '连接中',
  failed: '失败',
  disabled: '已禁用',
  pending: '待批准'
}

const STATUS_CLASS: Record<McpServerDetail['status'], string> = {
  connected: 'status-connected',
  connecting: 'status-connecting',
  failed: 'status-failed',
  disabled: 'status-disabled',
  pending: 'status-connecting'
}

export default function McpSettingsSection(): JSX.Element {
  const workspaceRoot = useWorkspaceStore((s) => s.workspace?.path ?? null)
  const [details, setDetails] = useState<McpServerDetail[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT)
  const [testMsg, setTestMsg] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const list = await window.lc.mcp.listStatus(workspaceRoot)
      setDetails(list)
    } finally {
      setLoading(false)
    }
  }, [workspaceRoot])

  useEffect(() => {
    void load()
    const off = window.lc.mcp.onStatus((next) => setDetails(next))
    return off
  }, [load])

  const setField = (key: keyof DraftState, value: string): void =>
    setDraft((d) => ({ ...d, [key]: value }))

  const resetForm = (): void => {
    setDraft(EMPTY_DRAFT)
    setFormError(null)
    setTestMsg(null)
  }

  const handleSave = async (): Promise<void> => {
    setFormError(null)
    const config = buildConfig(draft)
    if (!config) {
      setFormError(draft.transport === 'stdio' ? '请填写启动命令' : '请填写服务器 URL')
      return
    }
    setBusy(true)
    try {
      const res = await window.lc.mcp.saveServer({ name: draft.name.trim(), config, enabled: true })
      if (!res.ok) {
        setFormError(res.error ?? '保存失败')
        return
      }
      resetForm()
      await load()
    } finally {
      setBusy(false)
    }
  }

  const handleTest = async (): Promise<void> => {
    setTestMsg(null)
    const config = buildConfig(draft)
    if (!config) {
      setFormError(draft.transport === 'stdio' ? '请填写启动命令' : '请填写服务器 URL')
      return
    }
    setBusy(true)
    try {
      const res = await window.lc.mcp.testConnection(config)
      if (res.ok) {
        setTestMsg(`连接成功，发现 ${res.toolCount ?? 0} 个工具${res.serverInfo ? `（${res.serverInfo.name} ${res.serverInfo.version}）` : ''}`)
      } else {
        setTestMsg(`连接失败：${res.error ?? '未知错误'}`)
      }
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (name: string): Promise<void> => {
    setBusy(true)
    try {
      await window.lc.mcp.deleteServer(name)
      await load()
    } finally {
      setBusy(false)
    }
  }

  const handleToggle = async (name: string, enabled: boolean): Promise<void> => {
    setBusy(true)
    try {
      await window.lc.mcp.setEnabled(name, enabled)
    } finally {
      setBusy(false)
    }
  }

  const handleRestart = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.lc.mcp.restart()
    } finally {
      setBusy(false)
    }
  }

  const handleApproval = async (name: string, state: 'approved' | 'rejected'): Promise<void> => {
    setBusy(true)
    try {
      await window.lc.mcp.setProjectApproval(name, state)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-section-page">
      <SettingsGroup label="已配置的 MCP 服务">
        {loading && <div className="settings-inline-alert">加载中…</div>}
        {!loading && details.length === 0 && (
          <div className="settings-inline-alert">尚未配置任何 MCP 服务。在下方添加，或在工作区放置 {PROJECT_MCP_PATH}。</div>
        )}
        {details.map((d) => (
          <div key={`${d.scope}:${d.name}`} className="mcp-server-row">
            <div className="mcp-server-info">
              <div className="mcp-server-name">
                <span>{d.name}</span>
                <span className={`settings-tag dot ${STATUS_CLASS[d.status]}`}>{STATUS_LABEL[d.status]}</span>
                <span className="settings-tag">{d.transport}</span>
                <span className="settings-tag">{d.scope === 'project' ? `项目 ${PROJECT_MCP_PATH}` : '用户'}</span>
              </div>
              <div className={`mcp-server-meta${d.status === 'failed' && d.error ? ' err' : ''}`}>
                {d.status === 'failed' && d.error
                  ? `错误：${d.error}`
                  : d.status === 'pending'
                    ? `来自项目 ${PROJECT_MCP_PATH}，需批准后才会连接（请确认你信任此仓库）。`
                    : `工具 ${d.toolCount} · 资源 ${d.resourceCount} · prompt ${d.promptCount}`}
              </div>
            </div>
            <div className="mcp-server-actions">
              {d.scope === 'project' && d.status === 'pending' && (
                <>
                  <button type="button" className="btn-secondary" disabled={busy} onClick={() => void handleApproval(d.name, 'rejected')}>
                    拒绝
                  </button>
                  <button type="button" className="btn" disabled={busy} onClick={() => void handleApproval(d.name, 'approved')}>
                    批准
                  </button>
                </>
              )}
              {d.scope === 'project' && d.status !== 'pending' && d.enabled && (
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => void handleApproval(d.name, 'rejected')}>
                  撤销
                </button>
              )}
              {d.scope === 'project' && d.status !== 'pending' && !d.enabled && (
                <button type="button" className="btn" disabled={busy} onClick={() => void handleApproval(d.name, 'approved')}>
                  批准
                </button>
              )}
              {d.scope === 'user' && (
                <SettingsSwitch
                  checked={d.enabled}
                  disabled={busy}
                  onChange={(v) => void handleToggle(d.name, v)}
                />
              )}
              {d.scope === 'user' && (
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => void handleDelete(d.name)}>
                  删除
                </button>
              )}
            </div>
          </div>
        ))}
        <div className="settings-actions">
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => void handleRestart()}>
            重连全部
          </button>
        </div>
      </SettingsGroup>

      <SettingsGroup label="添加 MCP 服务">
        <SettingsRow
          title="名称"
          description="只能包含字母、数字、下划线、连字符。"
          stacked
          control={
            <input
              type="text"
              placeholder="例如 filesystem"
              disabled={busy}
              value={draft.name}
              onChange={(e) => setField('name', e.target.value)}
            />
          }
        />
        <SettingsRow
          title="传输方式"
          stacked
          control={
            <select
              disabled={busy}
              value={draft.transport}
              onChange={(e) => setField('transport', e.target.value as TransportOption)}
            >
              <option value="stdio">stdio（本地子进程）</option>
              <option value="http">Streamable HTTP（远程）</option>
              <option value="sse">SSE（远程）</option>
            </select>
          }
        />
        {draft.transport === 'stdio' ? (
          <>
            <SettingsRow
              title="启动命令"
              description="例如 npx 或可执行文件路径。"
              stacked
              control={
                <input
                  type="text"
                  placeholder="npx"
                  disabled={busy}
                  value={draft.command}
                  onChange={(e) => setField('command', e.target.value)}
                />
              }
            />
            <SettingsRow
              title="参数"
              description="每行一个参数。"
              stacked
              control={
                <textarea
                  rows={3}
                  placeholder={'-y\n@modelcontextprotocol/server-filesystem\n.'}
                  disabled={busy}
                  value={draft.args}
                  onChange={(e) => setField('args', e.target.value)}
                />
              }
            />
            <SettingsRow
              title="环境变量"
              description="每行一个 KEY=VALUE，支持 ${VAR} 展开。"
              stacked
              control={
                <textarea
                  rows={2}
                  placeholder="API_KEY=${MY_API_KEY}"
                  disabled={busy}
                  value={draft.env}
                  onChange={(e) => setField('env', e.target.value)}
                />
              }
            />
          </>
        ) : (
          <>
            <SettingsRow
              title="服务器 URL"
              stacked
              control={
                <input
                  type="text"
                  placeholder="https://example.com/mcp"
                  disabled={busy}
                  value={draft.url}
                  onChange={(e) => setField('url', e.target.value)}
                />
              }
            />
            <SettingsRow
              title="请求头"
              description="每行一个 KEY=VALUE，支持 ${VAR} 展开。"
              stacked
              control={
                <textarea
                  rows={2}
                  placeholder="Authorization=Bearer ${TOKEN}"
                  disabled={busy}
                  value={draft.headers}
                  onChange={(e) => setField('headers', e.target.value)}
                />
              }
            />
          </>
        )}
        {formError && <div className="settings-inline-alert">{formError}</div>}
        {testMsg && <div className="settings-inline-alert">{testMsg}</div>}
        <div className="settings-actions">
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => void handleTest()}>
            测试连接
          </button>
          <button type="button" className="btn" disabled={busy || !draft.name.trim()} onClick={() => void handleSave()}>
            保存并连接
          </button>
        </div>
      </SettingsGroup>
    </div>
  )
}
