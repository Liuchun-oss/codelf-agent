import { z } from 'zod'
import type { Tool, ToolResult } from '../tools/types'
import { getMcpManager } from './manager'

export const LIST_MCP_RESOURCES_NAME = 'ListMcpResources'
export const READ_MCP_RESOURCE_NAME = 'ReadMcpResource'
export const LIST_MCP_PROMPTS_NAME = 'ListMcpPrompts'
export const GET_MCP_PROMPT_NAME = 'GetMcpPrompt'

const listSchema = z.object({
  server: z.string().optional().describe('可选：只列出该 MCP server 的资源')
})

export const listMcpResourcesTool: Tool<z.infer<typeof listSchema>> = {
  name: LIST_MCP_RESOURCES_NAME,
  description:
    '列出已连接 MCP server 暴露的资源（resources）。返回每个资源的 server、uri、名称与描述，便于随后用 ReadMcpResource 读取。',
  schema: listSchema,
  readOnly: true,
  concurrencySafe: true,
  deferred: true,
  async execute(input): Promise<ToolResult> {
    const entries = getMcpManager().listResourceEntries()
    const filtered = input.server ? entries.filter((e) => e.serverName === input.server) : entries
    if (filtered.length === 0) {
      return { content: input.server ? `MCP server "${input.server}" 没有可用资源` : '当前没有可用的 MCP 资源' }
    }
    const lines: string[] = []
    for (const { serverName, resources } of filtered) {
      lines.push(`# ${serverName}`)
      for (const r of resources) {
        const name = r.name ? ` ${r.name}` : ''
        const mime = r.mimeType ? ` (${r.mimeType})` : ''
        const desc = r.description ? ` — ${r.description}` : ''
        lines.push(`- ${r.uri}${name}${mime}${desc}`)
      }
    }
    return { content: lines.join('\n') }
  }
}

const readSchema = z.object({
  server: z.string().describe('资源所属的 MCP server 名称'),
  uri: z.string().describe('要读取的资源 URI（来自 ListMcpResources）')
})

export const readMcpResourceTool: Tool<z.infer<typeof readSchema>> = {
  name: READ_MCP_RESOURCE_NAME,
  description: '读取指定 MCP server 的某个资源内容（按 uri）。二进制资源不会返回原始数据。',
  schema: readSchema,
  readOnly: true,
  concurrencySafe: true,
  deferred: true,
  async execute(input): Promise<ToolResult> {
    const result = await getMcpManager().readResource(input.server, input.uri)
    return { content: result.text, isError: result.isError }
  }
}

const listPromptsSchema = z.object({
  server: z.string().optional().describe('可选：只列出该 MCP server 的 prompt')
})

export const listMcpPromptsTool: Tool<z.infer<typeof listPromptsSchema>> = {
  name: LIST_MCP_PROMPTS_NAME,
  description:
    '列出已连接 MCP server 暴露的 prompt（预设提示词模板）。返回每个 prompt 的 server、名称与描述，随后可用 GetMcpPrompt 获取其内容。',
  schema: listPromptsSchema,
  readOnly: true,
  concurrencySafe: true,
  deferred: true,
  async execute(input): Promise<ToolResult> {
    const entries = getMcpManager().listPromptEntries()
    const filtered = input.server ? entries.filter((e) => e.serverName === input.server) : entries
    if (filtered.length === 0) {
      return { content: input.server ? `MCP server "${input.server}" 没有可用 prompt` : '当前没有可用的 MCP prompt' }
    }
    const lines: string[] = []
    for (const { serverName, prompts } of filtered) {
      lines.push(`# ${serverName}`)
      for (const p of prompts) {
        lines.push(`- ${p.name}${p.description ? ` — ${p.description}` : ''}`)
      }
    }
    return { content: lines.join('\n') }
  }
}

const getPromptSchema = z.object({
  server: z.string().describe('prompt 所属的 MCP server 名称'),
  name: z.string().describe('prompt 名称（来自 ListMcpPrompts）'),
  arguments: z
    .record(z.string(), z.string())
    .optional()
    .describe('prompt 参数，键值对（字符串）')
})

export const getMcpPromptTool: Tool<z.infer<typeof getPromptSchema>> = {
  name: GET_MCP_PROMPT_NAME,
  description:
    '获取指定 MCP server 的某个 prompt 渲染后的消息内容（按 name 与可选参数）。返回的文本可作为后续操作的上下文或指引。',
  schema: getPromptSchema,
  readOnly: true,
  concurrencySafe: true,
  deferred: true,
  async execute(input): Promise<ToolResult> {
    const result = await getMcpManager().getPrompt(input.server, input.name, input.arguments ?? {})
    return { content: result.text, isError: result.isError }
  }
}
