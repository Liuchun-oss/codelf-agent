import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { McpApprovalState, McpConfigScope, McpServerConfig } from '@shared/mcpTypes'
import {
  isStdioConfig,
  parseMcpJsonFile
} from '@shared/mcpTypes'
import { DATA_DIR_NAME, PROJECT_MCP_FILE_NAME } from '@shared/appConfig'
import { getMcpSettings } from '../settings/agentSettingsStore'

// 解析后的、待连接的 server 描述（已展开环境变量）。
export interface ResolvedMcpServer {
  name: string
  scope: McpConfigScope
  enabled: boolean
  config: McpServerConfig
  // 仅项目级（.mcp.json）server 有意义：用户对它的审批状态。
  // undefined 表示尚未决定（pending），需用户批准后才连接。
  approval?: McpApprovalState
}

// 展开 ${VAR} 与 ${VAR:-default}。
export function expandEnvVars(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, fallback?: string) => {
    const env = process.env[name]
    if (env !== undefined && env !== '') return env
    return fallback ?? ''
  })
}

function expandConfig(config: McpServerConfig): McpServerConfig {
  if (isStdioConfig(config)) {
    return {
      type: 'stdio',
      command: expandEnvVars(config.command),
      args: (config.args ?? []).map(expandEnvVars),
      env: config.env
        ? Object.fromEntries(Object.entries(config.env).map(([k, v]) => [k, expandEnvVars(v)]))
        : undefined
    }
  }
  return {
    type: config.type,
    url: expandEnvVars(config.url),
    headers: config.headers
      ? Object.fromEntries(Object.entries(config.headers).map(([k, v]) => [k, expandEnvVars(v)]))
      : undefined
  }
}

// 读取项目级 MCP 配置（标准 mcpServers 格式）。位于工作区的 .codelf/mcp.json。
function loadProjectMcpJson(workspaceRoot: string): Record<string, McpServerConfig> {
  const file = join(workspaceRoot, DATA_DIR_NAME, PROJECT_MCP_FILE_NAME)
  if (!existsSync(file)) return {}
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8'))
    return parseMcpJsonFile(raw)
  } catch {
    console.error(`[mcp] ${DATA_DIR_NAME}/${PROJECT_MCP_FILE_NAME} 解析失败，已忽略`)
    return {}
  }
}

// 合并用户级（settings.json 的 mcp 字段）与项目级（.mcp.json）配置。
// 同名时项目级优先级更高（project > user）。
export function resolveMcpServers(workspaceRoot: string | null): ResolvedMcpServer[] {
  const result = new Map<string, ResolvedMcpServer>()

  const userSettings = getMcpSettings()
  for (const [name, entry] of Object.entries(userSettings.servers)) {
    result.set(name, {
      name,
      scope: 'user',
      enabled: entry.enabled !== false,
      config: expandConfig(entry.config)
    })
  }

  if (workspaceRoot) {
    const projectServers = loadProjectMcpJson(workspaceRoot)
    const approvals = userSettings.projectApprovals?.[workspaceRoot] ?? {}
    for (const [name, config] of Object.entries(projectServers)) {
      result.set(name, {
        name,
        scope: 'project',
        // 项目 server 未审批前不启用；审批状态决定能否连接。
        enabled: approvals[name] === 'approved',
        approval: approvals[name],
        config: expandConfig(config)
      })
    }
  }

  return [...result.values()]
}
