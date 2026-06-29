// Codex / Claude 插件清单（plugin.json）类型与解析。
// 在主进程与渲染进程之间共享，因此不得依赖任何 Electron / Node 专有 API。

import type { McpServerConfig } from './mcpTypes'
import { normalizeServerConfig, MCP_SERVER_NAME_PATTERN } from './mcpTypes'

// 插件清单文件可能出现的位置（相对仓库根，按优先级）。
export const PLUGIN_MANIFEST_PATHS = [
  '.codex-plugin/plugin.json',
  '.claude-plugin/plugin.json'
] as const

// 插件名只允许字母、数字、下划线、连字符、点。
export const PLUGIN_NAME_PATTERN = /^[a-zA-Z0-9_.-]{1,64}$/

// 校验插件名是否可安全用作单层目录名：
// - 必须匹配字符白名单
// - 不得为 "." / ".."（否则拼路径后会逃逸到安装根之外）
// - 不得包含路径分隔符
export function isSafePluginName(name: string): boolean {
  if (!PLUGIN_NAME_PATTERN.test(name)) return false
  if (name === '.' || name === '..') return false
  if (name.includes('/') || name.includes('\\')) return false
  return true
}

// 为插件的 MCP server 名加上插件命名空间，避免与用户或其它插件的同名 server
// 互相覆盖/卸载误删。分隔符用 '-'（不能用 '__'，否则会破坏 mcp__server__tool 的解析）。
// 结果归一化到 MCP server 名白名单（[A-Za-z0-9_-]）并截断到 64 字符。
export function pluginMcpServerName(pluginName: string, serverName: string): string {
  // 折叠连续的 '_'：下划线虽是合法字符，但 '__' 会破坏 mcp__server__tool 的解析。
  const norm = (s: string): string =>
    s.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/_+/g, '_').replace(/-+/g, '-')
  const combined = `${norm(pluginName)}-${norm(serverName)}`
    .replace(/_+/g, '_')
    .replace(/-+/g, '-')
    .replace(/^[-_]|[-_]$/g, '')
  return combined.slice(0, 64)
}

export interface PluginManifest {
  name: string
  version?: string
  description?: string
  // skills 字段：插件内 skills 目录的相对路径（如 "./skills/"）。
  skillsDir?: string
  // mcpServers 字段：可以是指向 .mcp.json 的相对路径，或内联的 { server: config } 对象。
  mcpServersRef?: string
  mcpServersInline?: Record<string, McpServerConfig>
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

// 解析 plugin.json 原始内容为归一化的 PluginManifest，非法返回 null。
export function parsePluginManifest(raw: unknown): PluginManifest | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>

  const name = asString(obj.name)
  if (!name || !isSafePluginName(name)) return null

  const manifest: PluginManifest = { name }
  manifest.version = asString(obj.version)
  manifest.description = asString(obj.description)

  // skills：官方用字符串路径；也兼容直接给目录名。
  const skills = obj.skills
  if (typeof skills === 'string' && skills.trim()) {
    manifest.skillsDir = skills.trim()
  }

  // mcpServers：字符串视为 .mcp.json 引用；对象视为内联定义。
  const mcp = obj.mcpServers
  if (typeof mcp === 'string' && mcp.trim()) {
    manifest.mcpServersRef = mcp.trim()
  } else if (mcp && typeof mcp === 'object') {
    const inline: Record<string, McpServerConfig> = {}
    for (const [serverName, configRaw] of Object.entries(mcp as Record<string, unknown>)) {
      if (!MCP_SERVER_NAME_PATTERN.test(serverName)) continue
      const config = normalizeServerConfig(configRaw)
      if (config) inline[serverName] = config
    }
    if (Object.keys(inline).length > 0) manifest.mcpServersInline = inline
  }

  return manifest
}

// 渲染进程安装插件后收到的结果摘要。
export interface PluginInstallResult {
  ok: boolean
  error?: string
  pluginName?: string
  version?: string
  installDir?: string
  label?: string
  skills?: string[]
  mcpServers?: string[]
  notes?: string[]
  errors?: string[]
}

// 写入安装目录的安装记录（~/.codelf/plugins/<name>/.codelf-plugin.json），
// 用于「插件管理」列出与卸载时联动清理。
export interface PluginInstallRecord {
  pluginName: string
  version?: string
  description?: string
  sourceLabel?: string
  gitUrl?: string
  installedAt: string
  skills: string[]
  mcpServers: string[]
}

// 设置界面展示的已安装插件信息。
export interface InstalledPluginInfo extends PluginInstallRecord {
  installDir: string
  // 随应用分发的内置插件（位于 resources/plugins）：只读，不可卸载。
  builtin?: boolean
}

export interface PluginUninstallResult {
  ok: boolean
  error?: string
  removedMcpServers?: string[]
}

// 安装过程的分步进度事件（主进程经 IPC 'plugins:installProgress' 推送给渲染层）。
export type PluginInstallStage =
  | 'clone'
  | 'manifest'
  | 'copy'
  | 'skills'
  | 'mcp'
  | 'deps'
  | 'finalize'
  | 'done'
  | 'error'

export interface PluginInstallProgress {
  // 本次安装的关联 id，便于前端只认自己发起的那次。
  installId: string
  stage: PluginInstallStage
  // 人类可读的进度文字。
  message: string
}
