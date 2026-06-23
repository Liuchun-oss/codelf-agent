import { z } from 'zod'
import type { Tool, ToolResult } from './types'
import { installPluginFromSource, persistPluginMcpServers } from '../plugins/installPlugin'
import { getMcpManager } from '../mcp/manager'
import { listQueryEngineSessionIds, getExistingQueryEngine } from '../orchestrator/queryEngine'
import { APP_NAME, DATA_DIR_NAME } from '@shared/appConfig'

export const INSTALL_PLUGIN_TOOL_NAME = 'InstallPlugin'

const installPluginSchema = z.object({
  source: z
    .string()
    .min(1)
    .describe('Plugin source: GitHub shorthand (owner/repo), full GitHub URL, a /tree/ URL, or any git URL. The repo must contain .codex-plugin/plugin.json or .claude-plugin/plugin.json')
})

type InstallPluginInput = z.infer<typeof installPluginSchema>

// 重连所有 MCP server，并把最新工具同步进所有活跃会话的 registry。
async function reloadAndResyncMcp(workspaceRoot: string | null): Promise<void> {
  await getMcpManager().reloadAll(workspaceRoot)
  for (const sessionId of listQueryEngineSessionIds()) {
    getExistingQueryEngine(sessionId)?.resyncMcpTools()
  }
}

export const installPluginTool: Tool<InstallPluginInput> = {
  name: INSTALL_PLUGIN_TOOL_NAME,
  description:
    `Install a Codex/Claude plugin from a git source into ~/${DATA_DIR_NAME}/plugins. Clones the repo, reads its plugin manifest (.codex-plugin/plugin.json or .claude-plugin/plugin.json), installs bundled skills (adapted to ${APP_NAME} conventions) and registers the plugin's MCP servers into user settings. Installed skills appear in the Available skills list and MCP tools become available after reconnect. Accepts owner/repo, full GitHub URLs, /tree/ URLs, and git URLs. Requires git on the machine.`,
  schema: installPluginSchema,
  readOnly: false,
  concurrencySafe: false,
  async execute(input, ctx): Promise<ToolResult> {
    try {
      const result = await installPluginFromSource({ source: input.source, signal: ctx.signal })

      const registeredMcp = persistPluginMcpServers(result.mcpServers)
      if (registeredMcp.length > 0) {
        await reloadAndResyncMcp(ctx.workspaceRoot)
      }

      const lines: string[] = []
      lines.push(`插件: ${result.pluginName}${result.version ? ` v${result.version}` : ''}`)
      lines.push(`来源: ${result.sourceLabel} (${result.gitUrl})`)
      lines.push(`安装目录: ${result.installDir}`)
      if (result.description) lines.push(`描述: ${result.description}`)

      if (result.skills.length > 0) {
        lines.push('', `安装了 ${result.skills.length} 个 skill:`)
        for (const skill of result.skills) {
          lines.push(`- ${skill.name} → ${skill.targetDir}`)
          for (const note of skill.notes) lines.push(`  note: ${note}`)
        }
      } else {
        lines.push('', '未发现可安装的 skill。')
      }

      if (registeredMcp.length > 0) {
        lines.push('', `注册了 ${registeredMcp.length} 个 MCP server: ${registeredMcp.join(', ')}`)
        lines.push('MCP 工具将在重连后可用（已触发重连）。')
      } else {
        lines.push('', '未注册 MCP server。')
      }

      for (const note of result.notes) lines.push(`note: ${note}`)
      if (result.errors.length > 0) {
        lines.push('', '错误:')
        for (const err of result.errors) lines.push(`- ${err}`)
      }

      lines.push('', '提示: skill 将在下一轮出现在可用列表中，用 Skill 工具按名称调用。')

      // 克隆、解析、落盘成功即视为安装成功；技能/MCP 数量仅作附加信息。
      // 解析期间记录的非致命错误通过 result.errors 暴露，但不应判定整体失败。
      return { content: lines.join('\n'), isError: false }
    } catch (e) {
      return { content: `安装插件失败: ${e instanceof Error ? e.message : String(e)}`, isError: true }
    }
  }
}
