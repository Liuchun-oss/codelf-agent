import { ipcMain, type WebContents } from 'electron'
import type { McpServerConfig, McpServerDetail, McpServerDraft, McpSettings } from '@shared/mcpTypes'
import { MCP_SERVER_NAME_PATTERN, normalizeServerConfig } from '@shared/mcpTypes'
import { getMcpSettings, saveMcpSettings, setMcpProjectApproval } from '../agent/settings/agentSettingsStore'
import { getMcpManager } from '../agent/mcp/manager'
import { listQueryEngineSessionIds, getExistingQueryEngine } from '../agent/orchestrator/queryEngine'

interface McpOpResult {
  ok: boolean
  error?: string
}

// 重新连接所有 server，并把最新工具同步进所有活跃会话的 registry。
async function reloadAndResync(workspaceRoot: string | null): Promise<void> {
  await getMcpManager().reloadAll(workspaceRoot)
  for (const sessionId of listQueryEngineSessionIds()) {
    const engine = getExistingQueryEngine(sessionId)
    engine?.resyncMcpTools()
  }
}

let lastWorkspaceRoot: string | null = null

export function registerMcpIpc(): void {
  // 监听管理器状态变化，推送给所有渲染进程。
  getMcpManager().onChange(() => {
    const details = getMcpManager().buildDetails()
    for (const wc of trackedWebContents) {
      if (!wc.isDestroyed()) wc.send('mcp:status', details)
    }
  })

  ipcMain.handle('mcp:getSettings', async (): Promise<McpSettings> => getMcpSettings())

  ipcMain.handle(
    'mcp:listStatus',
    async (e, workspaceRoot?: string | null): Promise<McpServerDetail[]> => {
      trackWebContents(e.sender)
      lastWorkspaceRoot = workspaceRoot ?? null
      await getMcpManager().ensureConnected(lastWorkspaceRoot)
      return getMcpManager().buildDetails()
    }
  )

  ipcMain.handle(
    'mcp:saveServer',
    async (_e, draft: McpServerDraft): Promise<McpOpResult> => {
      if (!draft || typeof draft.name !== 'string' || !MCP_SERVER_NAME_PATTERN.test(draft.name)) {
        return { ok: false, error: '服务器名只能包含字母、数字、下划线、连字符，且长度 1-64' }
      }
      const config = normalizeServerConfig(draft.config)
      if (!config) return { ok: false, error: '服务器配置无效（缺少 command 或 url）' }
      const settings = getMcpSettings()
      const next: McpSettings = {
        servers: {
          ...settings.servers,
          [draft.name]: { config, enabled: draft.enabled !== false }
        }
      }
      saveMcpSettings(next)
      await reloadAndResync(lastWorkspaceRoot)
      return { ok: true }
    }
  )

  ipcMain.handle('mcp:deleteServer', async (_e, name: string): Promise<McpOpResult> => {
    const settings = getMcpSettings()
    if (!(name in settings.servers)) return { ok: true }
    const servers = { ...settings.servers }
    delete servers[name]
    saveMcpSettings({ servers })
    await reloadAndResync(lastWorkspaceRoot)
    return { ok: true }
  })

  ipcMain.handle(
    'mcp:setEnabled',
    async (_e, name: string, enabled: boolean): Promise<McpOpResult> => {
      const settings = getMcpSettings()
      const entry = settings.servers[name]
      if (!entry) return { ok: false, error: `未找到 server "${name}"` }
      saveMcpSettings({
        servers: { ...settings.servers, [name]: { ...entry, enabled } }
      })
      await reloadAndResync(lastWorkspaceRoot)
      return { ok: true }
    }
  )

  ipcMain.handle('mcp:restart', async (): Promise<McpOpResult> => {
    await reloadAndResync(lastWorkspaceRoot)
    return { ok: true }
  })

  // 批准/拒绝某个项目级（.mcp.json）server。批准后才会连接。
  ipcMain.handle(
    'mcp:setProjectApproval',
    async (_e, name: string, state: 'approved' | 'rejected'): Promise<McpOpResult> => {
      if (!lastWorkspaceRoot) return { ok: false, error: '未打开工作区' }
      if (typeof name !== 'string' || !name) return { ok: false, error: '无效的 server 名' }
      if (state !== 'approved' && state !== 'rejected') return { ok: false, error: '无效的审批状态' }
      setMcpProjectApproval(lastWorkspaceRoot, name, state)
      await reloadAndResync(lastWorkspaceRoot)
      return { ok: true }
    }
  )

  ipcMain.handle(
    'mcp:testConnection',
    async (_e, config: McpServerConfig) => {
      const normalized = normalizeServerConfig(config)
      if (!normalized) return { ok: false, error: '配置无效' }
      return getMcpManager().testConfig(normalized)
    }
  )
}

const trackedWebContents = new Set<WebContents>()

function trackWebContents(wc: WebContents): void {
  if (trackedWebContents.has(wc)) return
  trackedWebContents.add(wc)
  wc.once('destroyed', () => trackedWebContents.delete(wc))
}
