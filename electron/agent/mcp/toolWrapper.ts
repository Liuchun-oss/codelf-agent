import { z } from 'zod'
import type { Tool, ToolResult } from '../tools/types'
import type { McpDiscoveredTool } from './manager'
import { getMcpManager } from './manager'
import { mcpPermissionGroup, parseMcpToolName } from './naming'

// MCP 工具的入参由 MCP server 自行校验，这里用宽松 schema 放行任意对象。
const passthroughSchema = z.record(z.string(), z.unknown())

// 把单个 MCP 工具包装成本项目的 Tool。
export function wrapMcpTool(serverName: string, discovered: McpDiscoveredTool): Tool<Record<string, unknown>> {
  return {
    name: discovered.qualifiedName,
    description: discovered.description,
    schema: passthroughSchema,
    rawInputSchema: discovered.inputSchema,
    readOnly: discovered.readOnly,
    destructive: discovered.destructive,
    // 写工具串行执行更安全；只读工具允许并发。
    concurrencySafe: discovered.readOnly,
    deferred: true,
    permissionGroup: mcpPermissionGroup(serverName),
    async execute(input): Promise<ToolResult> {
      const parsed = parseMcpToolName(discovered.qualifiedName)
      if (!parsed) return { content: `无法解析 MCP 工具名 ${discovered.qualifiedName}`, isError: true }
      const result = await getMcpManager().callTool(parsed.serverName, discovered.originalName, input ?? {})
      return { content: result.text, isError: result.isError, images: result.images }
    }
  }
}

// 汇总所有已连接 server 的工具，包装为 Tool 列表。
export function buildMcpTools(): Tool<Record<string, unknown>>[] {
  const out: Tool<Record<string, unknown>>[] = []
  for (const { serverName, tools } of getMcpManager().allTools()) {
    for (const tool of tools) {
      out.push(wrapMcpTool(serverName, tool))
    }
  }
  return out
}
