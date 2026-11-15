import type { Tool } from '../tools/types'
import {
  isPathWithinWorkspace,
  pathFromArgs
} from './pathValidation'
import { loadMergedPermissionRules, matchPermissionRules } from './rules'
import type { MergedPermissionRules } from './rules'

export type PermissionVerdict = 'allow' | 'ask' | 'deny'

export interface PermissionDecideOptions {
  permissionMode?: 'default' | 'acceptEdits'
  workspaceRoot?: string | null
  /**
   * 越狱模式：在校验的最前面直接放行，连用户配置的 deny 规则、
   * 工作区外路径限制一并跳过。调用方负责保证可追溯性（写 audit.log）。
   */
  bypassAll?: boolean
}


export class PermissionEngine {
  private sessionGrants = new Set<string>()
  private sessionGroupGrants = new Set<string>()
  private rules: MergedPermissionRules = { allow: [], deny: [], ask: [] }

  
  loadRules(workspaceRoot?: string | null): void {
    this.rules = loadMergedPermissionRules(workspaceRoot)
  }

  decide(
    tool: Tool<unknown> | undefined,
    args: unknown,
    options?: PermissionDecideOptions
  ): PermissionVerdict {
    if (!tool) return 'deny'

    // 越狱模式：先于一切规则判定放行（含 deny 规则与工作区外路径限制）。
    if (options?.bypassAll) return 'allow'

    const p = pathFromArgs(args)
    if (p && options?.workspaceRoot && !isPathWithinWorkspace(options.workspaceRoot, p)) {
      if (tool.readOnly) return 'allow'
    }

    if (tool.readOnly) return 'allow'

    
    if (this.sessionGrants.has(tool.name)) return 'allow'
    if (tool.permissionGroup && this.sessionGroupGrants.has(tool.permissionGroup)) return 'allow'

    const ruleVerdict = matchPermissionRules(this.rules, tool, args)
    if (ruleVerdict) return ruleVerdict

    
    if (options?.permissionMode === 'acceptEdits') {
      return 'allow'
    }

    return 'ask'
  }

  isSessionGranted(toolName: string): boolean {
    return this.sessionGrants.has(toolName)
  }

  grantSession(toolName: string): void {
    this.sessionGrants.add(toolName)
  }

  
  grantSessionGroup(group: string): void {
    if (group) this.sessionGroupGrants.add(group)
  }

  isSessionGroupGranted(group: string): boolean {
    return this.sessionGroupGrants.has(group)
  }

  reset(): void {
    this.sessionGrants.clear()
    this.sessionGroupGrants.clear()
    this.rules = { allow: [], deny: [], ask: [] }
  }
}
