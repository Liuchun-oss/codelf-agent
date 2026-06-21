import { promises as fs } from 'fs'
import { join, relative, sep } from 'path'
import { DATA_DIR_NAME } from '@shared/appConfig'



export interface AgentRule {
  
  name: string
  
  path: string
  description?: string
  globs?: string[]
  alwaysApply: boolean
  
  body: string
}


export type RuleActivation = 'always' | 'autoAttached' | 'agentRequested' | 'manual'

export function ruleActivation(r: AgentRule): RuleActivation {
  if (r.alwaysApply) return 'always'
  if (r.globs && r.globs.length > 0) return 'autoAttached'
  if (r.description && r.description.trim()) return 'agentRequested'
  return 'manual'
}


export interface RuleMatchContext {
  
  activeFile?: string
}

const RULES_DIR = `${DATA_DIR_NAME}/rules`
const RULE_EXTS = new Set(['.md', '.mdc'])


export async function loadProjectRules(workspaceRoot: string | null | undefined): Promise<AgentRule[]> {
  if (!workspaceRoot) return []
  const dir = join(workspaceRoot, RULES_DIR)
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return []
  }
  const rules: AgentRule[] = []
  for (const name of entries) {
    const ext = extOf(name)
    if (!RULE_EXTS.has(ext)) continue
    const abs = join(dir, name)
    try {
      const stat = await fs.stat(abs)
      if (!stat.isFile()) continue
      const raw = await fs.readFile(abs, 'utf8')
      rules.push(parseRule(name, abs, raw))
    } catch {
      
    }
  }
  rules.sort((a, b) => a.name.localeCompare(b.name))
  return rules
}


export function pickApplicableRules(rules: AgentRule[], ctx: RuleMatchContext): AgentRule[] {
  if (rules.length === 0) return []
  const active = ctx.activeFile ? toPosix(ctx.activeFile) : null
  return rules.filter((r) => {
    if (r.alwaysApply) return true
    if (!active || !r.globs || r.globs.length === 0) return false
    return r.globs.some((g) => matchGlob(active, g))
  })
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i).toLowerCase() : ''
}

function toPosix(p: string): string {
  return p.split(sep).join('/').replace(/^\.\//, '')
}


export function parseRule(fileName: string, abs: string, raw: string): AgentRule {
  const name = fileName.replace(/\.[^.]+$/, '')
  const fm = extractFrontmatter(raw)
  return {
    name,
    path: abs,
    description: fm.meta.description,
    globs: fm.meta.globs,
    alwaysApply: fm.meta.alwaysApply === true,
    body: fm.body.trim()
  }
}

interface ParsedMeta {
  description?: string
  globs?: string[]
  alwaysApply?: boolean
}

function extractFrontmatter(raw: string): { meta: ParsedMeta; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return { meta: {}, body: raw }
  return { meta: parseYamlSubset(m[1]), body: raw.slice(m[0].length) }
}


function parseYamlSubset(text: string): ParsedMeta {
  const out: ParsedMeta = {}
  const lines = text.split(/\r?\n/)
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      i++
      continue
    }
    const kv = trimmed.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/)
    if (!kv) {
      i++
      continue
    }
    const key = kv[1]
    const rest = kv[2]
    if (key === 'description') {
      out.description = stripQuotes(rest)
      i++
    } else if (key === 'alwaysApply') {
      out.alwaysApply = /^true$/i.test(rest.trim())
      i++
    } else if (key === 'globs') {
      if (rest.trim().length > 0) {
        out.globs = parseInlineList(rest)
        i++
      } else {
        const acc: string[] = []
        i++
        while (i < lines.length) {
          const next = lines[i]
          const m = next.match(/^\s*-\s*(.*)$/)
          if (!m) break
          acc.push(stripQuotes(m[1]))
          i++
        }
        if (acc.length) out.globs = acc
      }
    } else {
      i++
    }
  }
  return out
}

function parseInlineList(text: string): string[] {
  const m = text.trim().match(/^\[(.*)\]$/)
  if (m) {
    return m[1]
      .split(',')
      .map((s) => stripQuotes(s.trim()))
      .filter((s) => s.length > 0)
  }
  return [stripQuotes(text.trim())].filter((s) => s.length > 0)
}

function stripQuotes(s: string): string {
  const t = s.trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1)
  }
  return t
}


export function matchGlob(path: string, glob: string): boolean {
  const p = toPosix(path)
  const g = glob.replace(/^\.\//, '')
  const re = globToRegExp(g)
  return re.test(p)
}

function globToRegExp(glob: string): RegExp {
  let re = '^'
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        
        re += '.*'
        i++
        if (glob[i + 1] === '/') i++ 
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      re += '\\' + c
    } else if (c === '/') {
      re += '/'
    } else {
      re += c
    }
  }
  re += '$'
  return new RegExp(re)
}


export function relPosix(workspaceRoot: string, abs: string): string {
  return relative(workspaceRoot, abs).split(sep).join('/')
}
