// MCP（Model Context Protocol）配置类型与归一化逻辑。
// 在主进程与渲染进程之间共享，因此不得依赖任何 Electron / Node 专有 API。

export type McpTransportType = 'stdio' | 'http' | 'sse'

export interface McpStdioServerConfig {
  type?: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
  // 子进程工作目录。插件 MCP server 常依赖从其安装目录运行。
  cwd?: string
}

export interface McpHttpServerConfig {
  type: 'http' | 'sse'
  url: string
  headers?: Record<string, string>
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig

// 持久化时附带的运行控制字段。
export interface McpServerEntry {
  config: McpServerConfig
  // 是否启用。默认 true；置 false 时不连接、不发现工具。
  enabled?: boolean
}

export interface McpSettings {
  servers: Record<string, McpServerEntry>
  // 项目级（.mcp.json）server 的审批决定，按工作区根目录分组。
  // 键为工作区绝对路径，值为该工作区内各 server 名 → 审批状态。
  projectApprovals?: Record<string, Record<string, McpApprovalState>>
}

export type McpApprovalState = 'approved' | 'rejected'

export const DEFAULT_MCP_SETTINGS: McpSettings = { servers: {} }

// 服务器名只允许字母、数字、下划线、连字符。
export const MCP_SERVER_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/

export function isStdioConfig(config: McpServerConfig): config is McpStdioServerConfig {
  return config.type === 'stdio' || config.type === undefined
}

export function isHttpConfig(config: McpServerConfig): config is McpHttpServerConfig {
  return config.type === 'http' || config.type === 'sse'
}

export function transportTypeOf(config: McpServerConfig): McpTransportType {
  if (isHttpConfig(config)) return config.type
  return 'stdio'
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return Object.keys(out).length > 0 ? out : undefined
}

// 把任意输入归一化为合法的 McpServerConfig，非法返回 null。
export function normalizeServerConfig(raw: unknown): McpServerConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const type = typeof obj.type === 'string' ? obj.type : undefined

  if (type === 'http' || type === 'sse') {
    if (typeof obj.url !== 'string' || obj.url.trim() === '') return null
    const config: McpHttpServerConfig = { type, url: obj.url.trim() }
    const headers = normalizeStringRecord(obj.headers)
    if (headers) config.headers = headers
    return config
  }

  // 省略 type 或 type === 'stdio' 视为 stdio（向后兼容）。
  if (typeof obj.command !== 'string' || obj.command.trim() === '') return null
  const config: McpStdioServerConfig = { type: 'stdio', command: obj.command.trim() }
  if (Array.isArray(obj.args)) {
    config.args = obj.args.filter((a): a is string => typeof a === 'string')
  }
  const env = normalizeStringRecord(obj.env)
  if (env) config.env = env
  if (typeof obj.cwd === 'string' && obj.cwd.trim()) config.cwd = obj.cwd.trim()
  return config
}

export function normalizeMcpSettings(raw: unknown): McpSettings {
  if (!raw || typeof raw !== 'object') return { servers: {} }
  const serversRaw = (raw as { servers?: unknown }).servers
  const servers: Record<string, McpServerEntry> = {}
  if (serversRaw && typeof serversRaw === 'object') {
    for (const [name, entryRaw] of Object.entries(serversRaw as Record<string, unknown>)) {
      if (!MCP_SERVER_NAME_PATTERN.test(name)) continue
      if (!entryRaw || typeof entryRaw !== 'object') continue
      const entry = entryRaw as Record<string, unknown>
      // 兼容两种形态：{ config, enabled } 或直接把配置平铺在条目里。
      const configSource = 'config' in entry ? entry.config : entry
      const config = normalizeServerConfig(configSource)
      if (!config) continue
      servers[name] = {
        config,
        enabled: entry.enabled === false ? false : true
      }
    }
  }

  const approvals = normalizeProjectApprovals((raw as { projectApprovals?: unknown }).projectApprovals)
  const result: McpSettings = { servers }
  if (approvals) result.projectApprovals = approvals
  return result
}

function normalizeProjectApprovals(
  raw: unknown
): Record<string, Record<string, McpApprovalState>> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: Record<string, Record<string, McpApprovalState>> = {}
  for (const [root, serversRaw] of Object.entries(raw as Record<string, unknown>)) {
    if (!serversRaw || typeof serversRaw !== 'object') continue
    const perServer: Record<string, McpApprovalState> = {}
    for (const [name, state] of Object.entries(serversRaw as Record<string, unknown>)) {
      if (state === 'approved' || state === 'rejected') perServer[name] = state
    }
    if (Object.keys(perServer).length > 0) out[root] = perServer
  }
  return Object.keys(out).length > 0 ? out : undefined
}

// ----- 运行时状态（主进程 → 渲染进程，用于 UI 展示）-----

export type McpConnectionStatus = 'connected' | 'connecting' | 'failed' | 'disabled' | 'pending'

export type McpConfigScope = 'user' | 'project'

export interface McpToolSummary {
  // 注册到工具系统中的完整名（mcp__<server>__<tool>）。
  qualifiedName: string
  // MCP server 原始工具名。
  originalName: string
  description: string
  readOnly: boolean
}

export interface McpResourceSummary {
  uri: string
  name?: string
  description?: string
  mimeType?: string
}

export interface McpPromptSummary {
  name: string
  description?: string
}

export interface McpServerRuntimeStatus {
  name: string
  scope: McpConfigScope
  transport: McpTransportType
  status: McpConnectionStatus
  enabled: boolean
  error?: string
  toolCount: number
  resourceCount: number
  promptCount: number
  serverInfo?: { name: string; version: string }
}

export interface McpServerDetail extends McpServerRuntimeStatus {
  config: McpServerConfig
  tools: McpToolSummary[]
  resources: McpResourceSummary[]
  prompts: McpPromptSummary[]
}

// 渲染进程保存 server 时提交的草案。
export interface McpServerDraft {
  name: string
  config: McpServerConfig
  enabled?: boolean
}

// 解析标准的 mcp.json（顶层 { mcpServers: {...} }）。
export function parseMcpJsonFile(raw: unknown): Record<string, McpServerConfig> {
  if (!raw || typeof raw !== 'object') return {}
  const serversRaw = (raw as { mcpServers?: unknown }).mcpServers
  if (!serversRaw || typeof serversRaw !== 'object') return {}
  const out: Record<string, McpServerConfig> = {}
  for (const [name, configRaw] of Object.entries(serversRaw as Record<string, unknown>)) {
    if (!MCP_SERVER_NAME_PATTERN.test(name)) continue
    const config = normalizeServerConfig(configRaw)
    if (config) out[name] = config
  }
  return out
}
