import { ipcMain } from 'electron'
import {
  installPluginFromSource,
  persistPluginMcpServers,
  listInstalledPlugins,
  uninstallPlugin
} from '../agent/plugins/installPlugin'
import { getMcpManager } from '../agent/mcp/manager'
import { listQueryEngineSessionIds, getExistingQueryEngine } from '../agent/orchestrator/queryEngine'
import type { PluginInstallResult, InstalledPluginInfo, PluginUninstallResult, PluginInstallProgress, PluginInstallStage } from '@shared/pluginTypes'

let lastWorkspaceRoot: string | null = null

async function reloadAndResyncMcp(workspaceRoot: string | null): Promise<void> {
  await getMcpManager().reloadAll(workspaceRoot)
  for (const sessionId of listQueryEngineSessionIds()) {
    getExistingQueryEngine(sessionId)?.resyncMcpTools()
  }
}

export function registerPluginsIpc(): void {
  ipcMain.handle(
    'plugins:install',
    async (e, source: string, workspaceRoot?: string | null, installId?: string): Promise<PluginInstallResult> => {
      if (typeof source !== 'string' || !source.trim()) {
        return { ok: false, error: '请填写 Git 地址或 owner/repo' }
      }
      lastWorkspaceRoot = workspaceRoot ?? lastWorkspaceRoot
      const sender = e.sender
      const emitProgress = (stage: PluginInstallStage, message: string): void => {
        if (!installId || sender.isDestroyed()) return
        sender.send('plugins:installProgress', { installId, stage, message } satisfies PluginInstallProgress)
      }
      try {
        const result = await installPluginFromSource({ source: source.trim(), onProgress: emitProgress })
        emitProgress('mcp', '正在注册并热加载 MCP 服务…')
        const registeredMcp = persistPluginMcpServers(result.mcpServers)
        if (registeredMcp.length > 0) {
          await reloadAndResyncMcp(lastWorkspaceRoot)
        }
        emitProgress('done', '安装完成')
        // 只要克隆、解析清单、落盘成功即视为安装成功；
        // 技能/MCP 为 0 的插件（仅含脚本/资源）也是合法的。
        return {
          ok: true,
          pluginName: result.pluginName,
          version: result.version,
          installDir: result.installDir,
          label: result.sourceLabel,
          skills: result.skills.map((s) => s.name),
          mcpServers: registeredMcp,
          notes: result.notes,
          errors: result.errors
        }
      } catch (err) {
        emitProgress('error', err instanceof Error ? err.message : String(err))
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle('plugins:list', async (): Promise<InstalledPluginInfo[]> => {
    return listInstalledPlugins()
  })

  ipcMain.handle(
    'plugins:uninstall',
    async (_e, pluginName: string, workspaceRoot?: string | null): Promise<PluginUninstallResult> => {
      if (typeof pluginName !== 'string' || !pluginName.trim()) {
        return { ok: false, error: '无效的插件名' }
      }
      lastWorkspaceRoot = workspaceRoot ?? lastWorkspaceRoot
      try {
        const removedMcpServers = await uninstallPlugin(pluginName.trim())
        if (removedMcpServers.length > 0) {
          await reloadAndResyncMcp(lastWorkspaceRoot)
        }
        return { ok: true, removedMcpServers }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
}
