import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { resolveUserDataDir } from '../permissions/rules'
import { HOOK_EVENTS, type HookCommand, type HookEvent, type HookMatcher, type HooksSettings } from './types'
import { DATA_DIR_NAME } from '@shared/appConfig'

function isHookCommand(v: unknown): v is HookCommand {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return o.type === 'command' && typeof o.command === 'string' && o.command.trim().length > 0
}

function sanitizeMatchers(raw: unknown): HookMatcher[] {
  if (!Array.isArray(raw)) return []
  const out: HookMatcher[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const o = entry as Record<string, unknown>
    const hooks = Array.isArray(o.hooks) ? o.hooks.filter(isHookCommand) : []
    if (hooks.length === 0) continue
    out.push({
      matcher: typeof o.matcher === 'string' ? o.matcher : undefined,
      hooks: hooks.map((h) => ({
        type: 'command',
        command: h.command,
        shell: h.shell === 'powershell' ? 'powershell' : h.shell === 'bash' ? 'bash' : undefined,
        timeout: typeof h.timeout === 'number' && h.timeout > 0 ? h.timeout : undefined,
        statusMessage: typeof h.statusMessage === 'string' ? h.statusMessage : undefined
      }))
    })
  }
  return out
}

function readHooksFile(filePath: string): HooksSettings {
  if (!existsSync(filePath)) return {}
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as { hooks?: Record<string, unknown> }
    const hooks = raw?.hooks
    if (!hooks || typeof hooks !== 'object') return {}
    const result: HooksSettings = {}
    for (const event of HOOK_EVENTS) {
      const matchers = sanitizeMatchers((hooks as Record<string, unknown>)[event])
      if (matchers.length > 0) result[event] = matchers
    }
    return result
  } catch {
    return {}
  }
}

function mergeHooks(base: HooksSettings, extra: HooksSettings): HooksSettings {
  const result: HooksSettings = {}
  for (const event of HOOK_EVENTS) {
    const merged = [...(base[event] ?? []), ...(extra[event] ?? [])]
    if (merged.length > 0) result[event] = merged
  }
  return result
}

export function loadMergedHooks(workspaceRoot?: string | null): HooksSettings {
  const userFile = join(resolveUserDataDir(), 'settings.json')
  let merged = readHooksFile(userFile)
  if (workspaceRoot) {
    const projFile = join(workspaceRoot, DATA_DIR_NAME, 'settings.json')
    merged = mergeHooks(merged, readHooksFile(projFile))
  }
  return merged
}

function matcherMatches(matcher: string | undefined, query: string | undefined): boolean {
  if (!matcher || matcher.trim() === '' || matcher === '*') return true
  if (query === undefined) return true
  try {
    return new RegExp(matcher).test(query)
  } catch {
    return matcher === query
  }
}

export function getMatchingHooks(hooks: HooksSettings, event: HookEvent, matchQuery?: string): HookCommand[] {
  const matchers = hooks[event] ?? []
  const out: HookCommand[] = []
  for (const m of matchers) {
    if (matcherMatches(m.matcher, matchQuery)) out.push(...m.hooks)
  }
  return out
}
