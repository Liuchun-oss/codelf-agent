export const TOOL_NAME_MAP: Record<string, string> = {
  read: 'read_file',
  readfile: 'read_file',
  read_file: 'read_file',
  view: 'read_file',
  write: 'write_file',
  writefile: 'write_file',
  write_file: 'write_file',
  create: 'write_file',
  edit: 'edit_file',
  editfile: 'edit_file',
  edit_file: 'edit_file',
  str_replace: 'edit_file',
  str_replace_editor: 'edit_file',
  multiedit: 'multi_edit',
  multi_edit: 'multi_edit',
  grep: 'grep',
  search: 'grep',
  ripgrep: 'grep',
  glob: 'Glob',
  find: 'Glob',
  ls: 'list_dir',
  list: 'list_dir',
  list_dir: 'list_dir',
  listdir: 'list_dir',
  bash: 'run_terminal_cmd',
  shell: 'run_terminal_cmd',
  sh: 'run_terminal_cmd',
  run: 'run_terminal_cmd',
  run_command: 'run_terminal_cmd',
  terminal: 'run_terminal_cmd',
  run_terminal_cmd: 'run_terminal_cmd',
  powershell: 'PowerShell',
  websearch: 'WebSearch',
  web_search: 'WebSearch',
  webfetch: 'web_fetch',
  web_fetch: 'web_fetch',
  fetch: 'web_fetch',
  todowrite: 'TodoWrite',
  todo_write: 'TodoWrite',
  task: 'run_subagent',
  agent: 'run_subagent',
  subagent: 'run_subagent',
  run_subagent: 'run_subagent',
  getdiagnostics: 'get_diagnostics',
  get_diagnostics: 'get_diagnostics',
  diagnostics: 'get_diagnostics',
  codebase_search: 'codebase_search',
  codebasesearch: 'codebase_search'
}

export interface ToolMappingResult {
  mapped: string[]
  unmapped: string[]
}

function stripToolArgs(raw: string): { base: string; suffix: string } {
  const trimmed = raw.trim()
  const parenIdx = trimmed.indexOf('(')
  if (parenIdx >= 0) return { base: trimmed.slice(0, parenIdx).trim(), suffix: trimmed.slice(parenIdx) }
  const colonIdx = trimmed.indexOf(':')
  if (colonIdx >= 0) return { base: trimmed.slice(0, colonIdx).trim(), suffix: trimmed.slice(colonIdx) }
  return { base: trimmed, suffix: '' }
}

export function mapToolName(raw: string): string | null {
  const { base } = stripToolArgs(raw)
  if (!base) return null
  const key = base.toLowerCase().replace(/[\s-]+/g, '_')
  if (TOOL_NAME_MAP[key]) return TOOL_NAME_MAP[key]
  const collapsed = key.replace(/_/g, '')
  return TOOL_NAME_MAP[collapsed] ?? null
}

export function mapAllowedTools(tools: string[]): ToolMappingResult {
  const mapped = new Set<string>()
  const unmapped: string[] = []
  for (const raw of tools) {
    const result = mapToolName(raw)
    if (result) mapped.add(result)
    else if (raw.trim()) unmapped.push(raw.trim())
  }
  return { mapped: [...mapped], unmapped }
}

export interface AdaptOptions {
  sourceRepo?: string
  skillNameHint?: string
}

export interface AdaptResult {
  content: string
  notes: string[]
}

interface SplitMarkdown {
  raw: string
  body: string
  hasFrontmatter: boolean
  lines: string[]
}

function splitFrontmatter(markdown: string): SplitMarkdown {
  const normalized = markdown.replace(/^\uFEFF/, '')
  if (!normalized.startsWith('---\n') && !normalized.startsWith('---\r\n')) {
    return { raw: '', body: normalized, hasFrontmatter: false, lines: [] }
  }
  const newline = normalized.startsWith('---\r\n') ? '\r\n' : '\n'
  const bodyStart = 3 + newline.length
  const endMatch = normalized.slice(bodyStart).match(/\r?\n---(?:\r?\n|$)/)
  if (!endMatch || endMatch.index === undefined) {
    return { raw: '', body: normalized, hasFrontmatter: false, lines: [] }
  }
  const end = bodyStart + endMatch.index
  const raw = normalized.slice(bodyStart, end)
  const body = normalized.slice(end + endMatch[0].length)
  return { raw, body, hasFrontmatter: true, lines: raw.split(/\r?\n/) }
}

function readScalar(lines: string[], ...keys: string[]): string | undefined {
  for (const key of keys) {
    const idx = lines.findIndex((l) => new RegExp(`^${key}\\s*:`, 'i').test(l))
    if (idx < 0) continue
    const inline = lines[idx].slice(lines[idx].indexOf(':') + 1).trim()
    if (/^[|>][+-]?$/.test(inline)) {
      const collected: string[] = []
      for (let i = idx + 1; i < lines.length; i += 1) {
        if (!/^\s+\S/.test(lines[i])) {
          if (lines[i].trim() === '') {
            collected.push('')
            continue
          }
          break
        }
        collected.push(lines[i].replace(/^\s+/, ''))
      }
      const joiner = inline.startsWith('|') ? '\n' : ' '
      const folded = collected.join(joiner).replace(/\s+/g, ' ').trim()
      if (folded) return folded
    }
    if (inline) return inline.replace(/^["'](.*)["']$/, '$1')
  }
  return undefined
}

function readList(lines: string[], ...keys: string[]): string[] {
  const out: string[] = []
  for (const key of keys) {
    const idx = lines.findIndex((l) => new RegExp(`^${key}\\s*:`, 'i').test(l))
    if (idx < 0) continue
    const inline = lines[idx].slice(lines[idx].indexOf(':') + 1).trim()
    if (inline.startsWith('[') && inline.endsWith(']')) {
      return inline
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["'](.*)["']$/, '$1'))
        .filter(Boolean)
    }
    if (inline) return inline.split(',').map((s) => s.trim()).filter(Boolean)
    for (let i = idx + 1; i < lines.length; i += 1) {
      const m = lines[i].match(/^\s*-\s*(.+)$/)
      if (!m) break
      out.push(m[1].trim().replace(/^["'](.*)["']$/, '$1'))
    }
    if (out.length) return out
  }
  return out
}

function yamlEscape(value: string): string {
  if (/[:#\-?[\]{}&*!|>'"%@`]/.test(value) || value.includes('\n')) {
    return `"${value.replace(/"/g, '\\"')}"`
  }
  return value
}

export function adaptSkillMarkdown(markdown: string, opts: AdaptOptions = {}): AdaptResult {
  const notes: string[] = []
  const { body, hasFrontmatter, lines } = splitFrontmatter(markdown)

  const rawName = readScalar(lines, 'id', 'name') ?? opts.skillNameHint ?? 'imported-skill'
  const id = rawName.trim().replace(/[^A-Za-z0-9_.-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase()
  const displayName = readScalar(lines, 'name') ?? rawName
  const description = readScalar(lines, 'description') ?? `Imported skill ${id}`
  const whenToUse = readScalar(lines, 'when_to_use', 'whenToUse')
  const rawContext = (readScalar(lines, 'context', 'execution_context') ?? 'inline').toLowerCase()
  const context = rawContext === 'fork' || rawContext === 'subagent' ? 'fork' : 'inline'
  const version = readScalar(lines, 'version') ?? '1.0'

  const rawTools = readList(lines, 'allowed-tools', 'allowed_tools', 'allowedTools')
  const { mapped, unmapped } = mapAllowedTools(rawTools)
  if (rawTools.length > 0) {
    notes.push(`allowed-tools 原始: [${rawTools.join(', ')}] → 映射: [${mapped.join(', ') || '无'}]`)
  }
  if (unmapped.length > 0) {
    notes.push(`无法映射的工具(已忽略): ${unmapped.join(', ')}`)
  }
  if (!hasFrontmatter) notes.push('原文件无 frontmatter，已根据正文生成。')

  const fm: string[] = ['---', `id: ${id}`, `name: ${yamlEscape(displayName)}`, `description: ${yamlEscape(description)}`]
  if (whenToUse) fm.push(`when_to_use: ${yamlEscape(whenToUse)}`)
  if (mapped.length > 0) fm.push(`allowed_tools: [${mapped.join(', ')}]`)
  fm.push(`context: ${context}`)
  fm.push(`version: ${yamlEscape(version)}`)
  if (opts.sourceRepo) fm.push(`source_repo: ${yamlEscape(opts.sourceRepo)}`)
  fm.push('---')

  return { content: `${fm.join('\n')}\n\n${body.trim()}\n`, notes }
}
