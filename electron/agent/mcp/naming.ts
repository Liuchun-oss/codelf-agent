// MCP 工具名的构造与解析：mcp__<server>__<tool>

export const MCP_TOOL_PREFIX = 'mcp__'

// 把非 [A-Za-z0-9_-] 字符替换为下划线（标准 MCP 名称规范化）。
export function normalizeNameForMcp(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_')
}

export function getMcpPrefix(serverName: string): string {
  return `${MCP_TOOL_PREFIX}${normalizeNameForMcp(serverName)}__`
}

export function buildMcpToolName(serverName: string, toolName: string): string {
  return `${getMcpPrefix(serverName)}${normalizeNameForMcp(toolName)}`
}

export interface ParsedMcpName {
  serverName: string
  toolName: string
}

// 解析 mcp__server__tool。tool 部分可能含 __，按 join 还原。
export function parseMcpToolName(qualified: string): ParsedMcpName | null {
  if (!qualified.startsWith(MCP_TOOL_PREFIX)) return null
  const rest = qualified.slice(MCP_TOOL_PREFIX.length)
  const parts = rest.split('__')
  if (parts.length < 2) return null
  const [serverName, ...toolParts] = parts
  if (!serverName || toolParts.length === 0) return null
  return { serverName, toolName: toolParts.join('__') }
}

// 该 server 对应的权限分组名（用于会话级整组授权）。
export function mcpPermissionGroup(serverName: string): string {
  return `mcp:${normalizeNameForMcp(serverName)}`
}

// MCP 相关的内置工具名（资源 / prompt 工具）。
const MCP_BUILTIN_TOOL_NAMES = new Set([
  'ListMcpResources',
  'ReadMcpResource',
  'ListMcpPrompts',
  'GetMcpPrompt'
])

// 判断某工具名是否属于 MCP（server 工具或 MCP 内置工具）。
export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX) || MCP_BUILTIN_TOOL_NAMES.has(name)
}
