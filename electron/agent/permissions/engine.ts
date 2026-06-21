import type { Tool } from '../tools/types'
import {
  commandFromArgs,
  commandReferencesSensitivePath,
  isPathWithinWorkspace,
  isSensitivePath,
  isSystemPath,
  pathFromArgs
} from './pathValidation'
import { loadMergedPermissionRules, matchPermissionRules } from './rules'
import type { MergedPermissionRules } from './rules'

export type PermissionVerdict = 'allow' | 'ask' | 'deny'

export interface PermissionDecideOptions {
  permissionMode?: 'default' | 'acceptEdits'
  workspaceRoot?: string | null
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

    const p = pathFromArgs(args)
    if (p && isSensitivePath(p)) return 'deny'
    if (p && isSystemPath(p) && !tool.readOnly) return 'deny'
    if (p && options?.workspaceRoot && !isPathWithinWorkspace(options.workspaceRoot, p)) {
      if (tool.readOnly) return 'allow'
    }

    
    
    const cmd = commandFromArgs(args)
    if (cmd && commandReferencesSensitivePath(cmd)) return 'deny'

    if (tool.readOnly) return 'allow'

    
    if (this.sessionGrants.has(tool.name)) return 'allow'
    if (tool.permissionGroup && this.sessionGroupGrants.has(tool.permissionGroup)) return 'allow'

    const ruleVerdict = matchPermissionRules(this.rules, tool, args)
    if (ruleVerdict) return ruleVerdict

    if (tool.destructive) return 'ask'

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
