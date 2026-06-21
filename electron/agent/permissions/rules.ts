import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Tool } from '../tools/types'
import { pathFromArgs } from './pathValidation'
import { DATA_DIR_NAME, tmpName } from '@shared/appConfig'

export interface PermissionRule {
  tool: string
  command?: string
  path?: string
}

export interface PermissionRulesConfig {
  allow?: PermissionRule[]
  deny?: PermissionRule[]
  ask?: PermissionRule[]
}

export interface MergedPermissionRules {
  allow: PermissionRule[]
  deny: PermissionRule[]
  ask: PermissionRule[]
}

function globToRegExp(glob: string): RegExp {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/\\\\]*')
    .replace(/\?/g, '.')
    .replace(/\u0000/g, '.*')
  return new RegExp(`^${body}$`, 'i')
}

function normPath(p: string): string {
  return p.replace(/\\/g, '/')
}

function toolNameMatches(ruleTool: string, toolName: string): boolean {
  if (ruleTool === toolName) return true
  // MCP 规则支持服务器级与通配：
  //  - "mcp__server"      匹配该 server 的所有工具
  //  - "mcp__server__*"   同上（显式通配）
  //  - "mcp__server__tool" 匹配特定工具
  if (ruleTool.startsWith('mcp__') && toolName.startsWith('mcp__')) {
    if (ruleTool.endsWith('__*')) {
      const prefix = ruleTool.slice(0, -1) // 去掉末尾 *，保留 "mcp__server__"
      return toolName.startsWith(prefix)
    }
    // 不含 __ 分隔的工具段视为服务器级规则
    if (!ruleTool.slice('mcp__'.length).includes('__')) {
      return toolName === ruleTool || toolName.startsWith(`${ruleTool}__`)
    }
  }
  return false
}

function ruleMatches(rule: PermissionRule, tool: Tool<unknown>, args: unknown): boolean {
  const toolName = tool.name
  if (!toolNameMatches(rule.tool, toolName) && rule.tool !== tool.permissionGroup) return false
  const cmd =
    args && typeof args === 'object' && 'command' in args && typeof (args as { command: unknown }).command === 'string'
      ? (args as { command: string }).command
      : undefined
  const path = pathFromArgs(args)
  if (rule.command != null) {
    if (!cmd || !globToRegExp(rule.command).test(cmd.trim())) return false
  }
  if (rule.path != null) {
    if (!path || !globToRegExp(normPath(rule.path)).test(normPath(path))) return false
  }
  return true
}

function readRulesFile(filePath: string): PermissionRulesConfig | null {
  if (!existsSync(filePath)) return null
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as { permissions?: PermissionRulesConfig }
    const p = raw?.permissions
    if (!p || typeof p !== 'object') return null
    return {
      allow: Array.isArray(p.allow) ? p.allow.filter(isRule) : [],
      deny: Array.isArray(p.deny) ? p.deny.filter(isRule) : [],
      ask: Array.isArray(p.ask) ? p.ask.filter(isRule) : []
    }
  } catch {
    return null
  }
}

function isRule(r: unknown): r is PermissionRule {
  return !!r && typeof r === 'object' && typeof (r as PermissionRule).tool === 'string'
}

export function resolveUserDataDir(): string {
  try {
    
    const { app } = require('electron') as { app?: { getPath?: (n: string) => string } }
    if (app?.getPath) return app.getPath('userData')
  } catch {
    
  }
  return join(tmpdir(), tmpName('userdata-fallback'))
}


export function loadMergedPermissionRules(workspaceRoot?: string | null): MergedPermissionRules {
  const userFile = join(resolveUserDataDir(), 'settings.json')
  const user = readRulesFile(userFile) ?? { allow: [], deny: [], ask: [] }
  let project = { allow: [] as PermissionRule[], deny: [] as PermissionRule[], ask: [] as PermissionRule[] }
  if (workspaceRoot) {
    const proj = readRulesFile(join(workspaceRoot, DATA_DIR_NAME, 'settings.json'))
    if (proj) project = { allow: proj.allow ?? [], deny: proj.deny ?? [], ask: proj.ask ?? [] }
  }
  return {
    deny: [...(project.deny ?? []), ...(user.deny ?? [])],
    allow: [...(project.allow ?? []), ...(user.allow ?? [])],
    ask: [...(project.ask ?? []), ...(user.ask ?? [])]
  }
}


export function matchPermissionRules(
  rules: MergedPermissionRules,
  tool: Tool<unknown>,
  args: unknown
): 'allow' | 'ask' | 'deny' | null {
  for (const r of rules.deny) {
    if (ruleMatches(r, tool, args)) return 'deny'
  }
  for (const r of rules.allow) {
    if (ruleMatches(r, tool, args)) return 'allow'
  }
  for (const r of rules.ask) {
    if (ruleMatches(r, tool, args)) return 'ask'
  }
  return null
}
