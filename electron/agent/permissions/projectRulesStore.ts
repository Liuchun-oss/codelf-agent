import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync } from 'fs'
import { join, dirname, basename } from 'path'
import { randomBytes } from 'crypto'
import type { PermissionRule, PermissionRulesConfig } from './rules'
import { DATA_DIR_NAME } from '@shared/appConfig'

interface ProjectSettingsFile {
  permissions?: PermissionRulesConfig
}

function projectSettingsPath(workspaceRoot: string): string {
  return join(workspaceRoot, DATA_DIR_NAME, 'settings.json')
}

function readProjectSettings(workspaceRoot: string): ProjectSettingsFile {
  const file = projectSettingsPath(workspaceRoot)
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as ProjectSettingsFile
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeProjectSettings(workspaceRoot: string, shape: ProjectSettingsFile): void {
  const dir = join(workspaceRoot, DATA_DIR_NAME)
  mkdirSync(dir, { recursive: true })
  const target = projectSettingsPath(workspaceRoot)
  const tmp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    writeFileSync(tmp, JSON.stringify(shape, null, 2), 'utf-8')
    renameSync(tmp, target)
  } catch (e) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      
    }
    throw e
  }
}

function ruleKey(r: PermissionRule): string {
  return `${r.tool}|${r.command ?? ''}|${r.path ?? ''}`
}


export function addProjectPermissionAllow(
  workspaceRoot: string,
  tool: string,
  details?: { command?: string; path?: string }
): void {
  const shape = readProjectSettings(workspaceRoot)
  const allow = shape.permissions?.allow ?? []
  const rule: PermissionRule = { tool }
  if (details?.command) rule.command = details.command
  if (details?.path) rule.path = details.path
  const keys = new Set(allow.map(ruleKey))
  if (keys.has(ruleKey(rule))) return
  shape.permissions = {
    allow: [...allow, rule],
    deny: shape.permissions?.deny ?? [],
    ask: shape.permissions?.ask ?? []
  }
  writeProjectSettings(workspaceRoot, shape)
}
