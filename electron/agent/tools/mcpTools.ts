import { z } from 'zod'
import type { Tool, ToolResult } from './types'
import { getMcpManager } from '../mcp/manager'
import { resolveMcpServers } from '../mcp/config'
import { setMcpProjectApproval } from '../settings/agentSettingsStore'

export const RELOAD_MCP_TOOL_NAME = 'ReloadMcpServers'

const reloadMcpSchema = z.object({
  approveProjectServers: z
    .boolean()
    .optional()
    .describe('是否自动批准当前工作区内所有待批的项目级（.codelf/mcp.json）server，默认 true')
})

// 重连所有 MCP server 并把最新工具同步进所有活跃会话。
// 通过动态 import 避免与 queryEngine 形成模块加载期循环依赖。
async function resyncAllSessions(): Promise<void> {
  const { listQueryEngineSessionIds, getExistingQueryEngine } = await import(
    '../orchestrator/queryEngine'
  )
  for (const sessionId of listQueryEngineSessionIds()) {
    getExistingQueryEngine(sessionId)?.resyncMcpTools()
  }
}

export const reloadMcpServersTool: Tool<z.infer<typeof reloadMcpSchema>> = {
  name: RELOAD_MCP_TOOL_NAME,
  description:
    '重连所有 MCP server，并把最新工具同步进当前会话。默认会自动批准当前工作区内所有待批的项目级 server，' +
    '因此可用于在 server 报错或新增配置后让其重新生效，无需用户手动到设置面板点重启。',
  schema: reloadMcpSchema,
  readOnly: false,
  concurrencySafe: false,
  async execute(input, ctx): Promise<ToolResult> {
    const workspaceRoot = ctx.workspaceRoot ?? null
    const approve = input.approveProjectServers !== false

    const approved: string[] = []
    if (approve && workspaceRoot) {
      for (const server of resolveMcpServers(workspaceRoot)) {
        if (server.scope === 'project' && server.approval !== 'approved') {
          setMcpProjectApproval(workspaceRoot, server.name, 'approved')
          approved.push(server.name)
        }
      }
    }

    await getMcpManager().reloadAll(workspaceRoot)
    await resyncAllSessions()

    const details = getMcpManager().buildDetails()
    if (details.length === 0) {
      return { content: '已重连：当前没有配置任何 MCP server。' }
    }

    const lines = details.map((d) => {
      const tail = d.status === 'connected' ? `已连接，${d.toolCount} 个工具` : d.error ? `${d.status}（${d.error}）` : d.status
      return `- ${d.name}（${d.scope}/${d.transport}）：${tail}`
    })
    const head = approved.length > 0 ? `已自动批准项目级 server：${approved.join('、')}。\n` : ''
    return { content: `${head}MCP 重连完成：\n${lines.join('\n')}` }
  }
}
