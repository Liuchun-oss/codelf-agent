import { promises as fs, readdirSync } from 'fs'
import { basename, delimiter, isAbsolute, join, resolve } from 'path'
import { homedir } from 'os'
import type { SkillDefinition, SkillExecutionContext, SkillSummary } from './types'
import { matchGlob, relPosix } from '../context/rules'
import { APP_NAME, DATA_DIR_NAME, ENV_SKILLS_DIR, ENV_USER_SKILLS_DIR } from '@shared/appConfig'
import type { SkillDetail, SkillSourceKind } from '@shared/skillTypes'
import { getSkillsSettings } from '../settings/agentSettingsStore'
import { localizeSkillDescription } from './translations'

const MAX_SKILL_BODY_CHARS = 80_000
const MAX_SKILLS = 80

interface ParsedMarkdown {
  frontmatter: Record<string, unknown>
  body: string
}

function parseScalar(value: string): string | boolean | number {
  const trimmed = value.trim()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed)
  const quoted = trimmed.match(/^["'](.*)["']$/)
  if (quoted) return quoted[1]
  return trimmed
}

function parseInlineList(value: string): string[] | undefined {
  const trimmed = value.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return undefined
  const inner = trimmed.slice(1, -1).trim()
  if (!inner) return []
  return inner
    .split(',')
    .map((part) => String(parseScalar(part)).trim())
    .filter(Boolean)
}

function parseFrontmatter(markdown: string): ParsedMarkdown {
  const normalized = markdown.replace(/^\uFEFF/, '')
  if (!normalized.startsWith('---\n') && !normalized.startsWith('---\r\n')) {
    return { frontmatter: {}, body: normalized }
  }

  const newline = normalized.startsWith('---\r\n') ? '\r\n' : '\n'
  const bodyStart = 3 + newline.length
  const endMatch = normalized.slice(bodyStart).match(/\r?\n---(?:\r?\n|$)/)
  if (!endMatch || endMatch.index === undefined) return { frontmatter: {}, body: normalized }

  const end = bodyStart + endMatch.index
  const raw = normalized.slice(bodyStart, end)
  const body = normalized.slice(end + endMatch[0].length)
  const frontmatter: Record<string, unknown> = {}
  const lines = raw.split(/\r?\n/)

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!match) continue
    const key = match[1]
    const value = match[2]
    const inlineList = parseInlineList(value)
    if (inlineList) {
      frontmatter[key] = inlineList
      continue
    }
    if (value.trim().length > 0) {
      frontmatter[key] = parseScalar(value)
      continue
    }

    const list: string[] = []
    while (i + 1 < lines.length) {
      const next = lines[i + 1]
      const listMatch = next.match(/^\s*-\s*(.+)$/)
      if (!listMatch) break
      list.push(String(parseScalar(listMatch[1])).trim())
      i += 1
    }
    frontmatter[key] = list
  }

  return { frontmatter, body }
}

function frontmatterString(frontmatter: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = frontmatter[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function frontmatterList(frontmatter: Record<string, unknown>, ...keys: string[]): string[] {
  for (const key of keys) {
    const value = frontmatter[key]
    if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean)
    if (typeof value === 'string' && value.trim()) {
      const inline = parseInlineList(value)
      if (inline) return inline
      return value.split(',').map((s) => s.trim()).filter(Boolean)
    }
  }
  return []
}

function normalizeSkillName(raw: string): string {
  return raw.trim().replace(/[^A-Za-z0-9_.-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
}

function parseExecutionContext(value: string | undefined): SkillExecutionContext {
  const normalized = value?.trim().toLowerCase()
  return normalized === 'fork' || normalized === 'subagent' || normalized === 'sub-agent'
    ? 'fork'
    : 'inline'
}

function parseSubagentType(frontmatter: Record<string, unknown>): string | undefined {
  const value = frontmatterString(
    frontmatter,
    'subagent_type',
    'subagent-type',
    'subagentType',
    'subagent',
    'agent_type',
    'agent-type',
    'agentType',
    'agent'
  )
  if (!value) return undefined
  const trimmed = value.trim()
  return /^[A-Za-z0-9_-]{1,80}$/.test(trimmed) ? trimmed : undefined
}

function inferDescription(body: string, fallbackName: string): string {
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('---')) continue
    return trimmed.length > 240 ? `${trimmed.slice(0, 237)}...` : trimmed
  }
  return `Skill ${fallbackName}`
}

export function summarizeSkill(skill: SkillDefinition): SkillSummary {
  return {
    name: skill.name,
    displayName: skill.displayName,
    description: skill.description,
    whenToUse: skill.whenToUse,
    allowedTools: skill.allowedTools,
    paths: skill.paths,
    context: skill.context,
    subagentType: skill.subagentType,
    source: skill.source,
    version: skill.version
  }
}

export function renderAvailableSkillsSection(skills: SkillSummary[]): string | null {
  if (skills.length === 0) return null
  const lines = skills.map((skill) => {
    const parts = [`- ${skill.name}`]
    if (skill.displayName && skill.displayName !== skill.name) parts.push(` (${skill.displayName})`)
    parts.push(` [${skill.source}]: ${skill.description}`)
    if (skill.whenToUse) parts.push(` When to use: ${skill.whenToUse}`)
    if (skill.allowedTools.length > 0) parts.push(` Allowed tools: ${skill.allowedTools.join(', ')}.`)
    if (skill.paths?.length) parts.push(` Paths: ${skill.paths.join(', ')}.`)
    if (skill.context === 'fork') {
      parts.push(' Runs in an isolated subagent context when invoked.')
      if (skill.subagentType) parts.push(` Preferred subagentType: ${skill.subagentType}.`)
    }
    return parts.join('')
  })
  return [
    '# Available skills',
    '',
    `Skills are reusable workflow prompts stored in project \`${DATA_DIR_NAME}/skills/<name>/SKILL.md\` or user \`~/${DATA_DIR_NAME}/skills/<name>/SKILL.md\`. Project skills override user skills with the same name. If a skill matches the user's task, call the \`Skill\` tool with its exact name before doing the workflow. The tool will load the full skill instructions on demand; do not assume the full instructions from this summary alone.`,
    '',
    'Some skills bundle helper scripts (e.g. `.py`, `.js`, `.sh`) next to their `SKILL.md`. When a skill body asks you to run such a script, resolve its path against the skill directory provided when the skill is loaded, then run it with the normal terminal tool. If the required runtime (python, node, etc.) is missing or the command fails, do not give up silently: fall back to any manual steps the skill describes, or accomplish the goal with your own tools, and tell the user what was unavailable.',
    '',
    ...lines
  ].join('\n')
}

async function loadSkillFile(dir: string, filePath: string, source: SkillDefinition['source']): Promise<SkillDefinition | null> {
  const raw = await fs.readFile(filePath, 'utf8')
  const { frontmatter, body } = parseFrontmatter(raw)
  const dirName = basename(dir)
  const rawName = frontmatterString(frontmatter, 'id') ?? dirName
  const name = normalizeSkillName(rawName)
  if (!name) return null
  const displayName = frontmatterString(frontmatter, 'name')
  const description = frontmatterString(frontmatter, 'description') ?? inferDescription(body, name)
  const whenToUse = frontmatterString(frontmatter, 'when_to_use', 'whenToUse')
  const allowedTools = frontmatterList(frontmatter, 'allowed_tools', 'allowed-tools', 'allowedTools')
  const paths = frontmatterList(frontmatter, 'paths', 'path_globs', 'path-globs', 'pathGlobs')
  const context = parseExecutionContext(frontmatterString(frontmatter, 'context', 'execution_context', 'executionContext'))
  const subagentType = parseSubagentType(frontmatter)
  const model = frontmatterString(frontmatter, 'model')
  const version = frontmatterString(frontmatter, 'version')
  const cappedBody = body.length > MAX_SKILL_BODY_CHARS
    ? `${body.slice(0, MAX_SKILL_BODY_CHARS)}\n…(skill body truncated, ${body.length - MAX_SKILL_BODY_CHARS} more chars)`
    : body

  return {
    name,
    displayName,
    description,
    whenToUse,
    allowedTools,
    paths: paths.length > 0 ? paths : undefined,
    context,
    subagentType,
    model,
    version,
    source,
    dir,
    filePath,
    body: cappedBody
  }
}

export function projectSkillsRoot(workspaceRoot: string | null | undefined): string | null {
  if (!workspaceRoot) return null
  return join(resolve(workspaceRoot), DATA_DIR_NAME, 'skills')
}


export const skillsRoot = projectSkillsRoot

export function builtinSkillsRoots(): string[] {
  const roots: string[] = []
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resourcesPath) roots.push(join(resourcesPath, 'skills'))
  roots.push(join(__dirname, '..', '..', 'resources', 'skills'))
  roots.push(resolve(process.cwd(), 'resources', 'skills'))
  return [...new Set(roots)]
}

// 随应用分发的「内置插件」根目录（如 resources/plugins）。
// 每个插件保留完整结构（skills/ + references/ + templates/ 等），故内部相对引用可用。
function builtinPluginsRoots(): string[] {
  const roots: string[] = []
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resourcesPath) roots.push(join(resourcesPath, 'plugins'))
  roots.push(join(__dirname, '..', '..', 'resources', 'plugins'))
  roots.push(resolve(process.cwd(), 'resources', 'plugins'))
  return [...new Set(roots)]
}

// 扫描内置插件目录，返回每个插件的 skills 子目录：resources/plugins/<name>/skills。
// 与用户插件（~/.codelf/plugins/*/skills）同源处理，作为 builtin 来源加载。
export function builtinPluginSkillsRoots(): string[] {
  const out: string[] = []
  for (const pluginsRoot of builtinPluginsRoots()) {
    try {
      for (const entry of readdirSync(pluginsRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) out.push(join(pluginsRoot, entry.name, 'skills'))
      }
    } catch {
      // 该候选根不存在，尝试下一个
    }
  }
  return [...new Set(out)]
}

export function userSkillsRoots(): string[] {
  const env = process.env[ENV_SKILLS_DIR] || process.env[ENV_USER_SKILLS_DIR]
  if (env?.trim()) {
    return env
      .split(delimiter)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => resolve(p))
  }
  const home = homedir()
  return home ? [join(home, DATA_DIR_NAME, 'skills')] : []
}

// 已安装插件各自的 skills 目录：~/<DATA_DIR_NAME>/plugins/<name>/skills
// 这些 skill 与用户 skill 同级（source: 'user'），可被禁用但展示为用户来源。
export function pluginSkillsRoots(): string[] {
  const home = homedir()
  if (!home) return []
  const pluginsRoot = join(home, DATA_DIR_NAME, 'plugins')
  try {
    return readdirSync(pluginsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(pluginsRoot, e.name, 'skills'))
  } catch {
    return []
  }
}

async function loadSkillsFromRoot(root: string | null, source: SkillDefinition['source']): Promise<SkillDefinition[]> {
  if (!root) return []

  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }

  const skills: SkillDefinition[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    const filePath = join(dir, 'SKILL.md')
    try {
      const stat = await fs.stat(filePath)
      if (!stat.isFile()) continue
      const skill = await loadSkillFile(dir, filePath, source)
      if (!skill || seen.has(skill.name)) continue
      seen.add(skill.name)
      skills.push(skill)
      if (skills.length >= MAX_SKILLS) break
    } catch {
      
    }
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

export async function loadProjectSkills(workspaceRoot: string | null | undefined): Promise<SkillDefinition[]> {
  return loadSkillsFromRoot(projectSkillsRoot(workspaceRoot), 'project')
}

export async function loadUserSkills(): Promise<SkillDefinition[]> {
  const merged = new Map<string, SkillDefinition>()
  for (const root of [...userSkillsRoots(), ...pluginSkillsRoots()]) {
    for (const skill of await loadSkillsFromRoot(root, 'user')) {
      if (!merged.has(skill.name.toLowerCase())) merged.set(skill.name.toLowerCase(), skill)
    }
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export async function loadBuiltinSkills(): Promise<SkillDefinition[]> {
  const merged = new Map<string, SkillDefinition>()
  for (const root of builtinSkillsRoots()) {
    for (const skill of await loadSkillsFromRoot(root, 'user')) {
      if (!merged.has(skill.name.toLowerCase())) merged.set(skill.name.toLowerCase(), skill)
    }
  }
  for (const root of builtinPluginSkillsRoots()) {
    for (const skill of await loadSkillsFromRoot(root, 'user')) {
      if (!merged.has(skill.name.toLowerCase())) merged.set(skill.name.toLowerCase(), skill)
    }
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export async function loadAvailableSkills(workspaceRoot: string | null | undefined): Promise<SkillDefinition[]> {
  const merged = new Map<string, SkillDefinition>()
  for (const skill of await loadBuiltinSkills()) merged.set(skill.name.toLowerCase(), skill)
  for (const skill of await loadUserSkills()) merged.set(skill.name.toLowerCase(), skill)
  for (const skill of await loadProjectSkills(workspaceRoot)) merged.set(skill.name.toLowerCase(), skill)
  const disabled = new Set(getSkillsSettings().disabled)
  return [...merged.values()]
    .filter((skill) => !disabled.has(skill.name.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name))
}

// 管理用：返回全部 skill（含被禁用的），并标注真实来源/启用/是否可删除。
export async function loadSkillsForManagement(
  workspaceRoot: string | null | undefined
): Promise<SkillDetail[]> {
  const disabled = new Set(getSkillsSettings().disabled)
  const byKey = new Map<string, { skill: SkillDefinition; kind: SkillSourceKind }>()
  // 优先级：project > user > builtin（与 loadAvailableSkills 的覆盖顺序一致）
  for (const skill of await loadBuiltinSkills()) byKey.set(skill.name.toLowerCase(), { skill, kind: 'builtin' })
  for (const skill of await loadUserSkills()) byKey.set(skill.name.toLowerCase(), { skill, kind: 'user' })
  for (const skill of await loadProjectSkills(workspaceRoot)) byKey.set(skill.name.toLowerCase(), { skill, kind: 'project' })

  return [...byKey.values()]
    .map(({ skill, kind }) => ({
      name: skill.name,
      displayName: skill.displayName,
      description: localizeSkillDescription(skill.name, skill.description),
      whenToUse: skill.whenToUse,
      version: skill.version,
      source: kind,
      dir: skill.dir,
      enabled: !disabled.has(skill.name.toLowerCase()),
      deletable: kind === 'user'
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export interface SkillMatchContext {
  workspaceRoot?: string | null
  activeFilePath?: string
}

function normalizeActivePath(ctx: SkillMatchContext): string | undefined {
  if (!ctx.activeFilePath) return undefined
  if (ctx.workspaceRoot && isAbsolute(ctx.activeFilePath)) return relPosix(ctx.workspaceRoot, ctx.activeFilePath)
  return ctx.activeFilePath.replace(/\\/g, '/').replace(/^\.\//, '')
}

export function pickApplicableSkills(skills: SkillDefinition[], ctx: SkillMatchContext): SkillDefinition[] {
  const active = normalizeActivePath(ctx)
  return skills.filter((skill) => {
    if (!skill.paths || skill.paths.length === 0) return true
    if (!active) return false
    return skill.paths.some((pattern) => matchGlob(active, pattern))
  })
}

export async function loadApplicableSkills(ctx: SkillMatchContext): Promise<SkillDefinition[]> {
  return pickApplicableSkills(await loadAvailableSkills(ctx.workspaceRoot), ctx)
}

export async function findProjectSkill(workspaceRoot: string | null | undefined, name: string): Promise<SkillDefinition | null> {
  const normalized = normalizeSkillName(name)
  const skills = await loadProjectSkills(workspaceRoot)
  return skills.find((skill) => skill.name.toLowerCase() === normalized.toLowerCase()) ?? null
}

export async function findSkill(workspaceRoot: string | null | undefined, name: string): Promise<SkillDefinition | null> {
  const normalized = normalizeSkillName(name)
  const skills = await loadAvailableSkills(workspaceRoot)
  return skills.find((skill) => skill.name.toLowerCase() === normalized.toLowerCase()) ?? null
}

export function resolveSkillDirPlaceholders(text: string, skillDir: string): string {
  const normalizedDir = skillDir.replace(/\\/g, '/')
  return text
    .replace(/\$\{SKILL_DIR\}/g, normalizedDir)
    .replace(/\$\{CLAUDE_SKILL_DIR\}/g, normalizedDir)
}

export function formatSkillForInvocation(skill: SkillDefinition, args?: string): string {
  const skillDirPosix = skill.dir.replace(/\\/g, '/')
  const body = resolveSkillDirPlaceholders(skill.body.trim(), skill.dir)
  const sections = [
    `<skill name="${skill.name}" context="${skill.context}">`,
    skill.allowedTools.length > 0
      ? skill.context === 'fork'
        ? `Allowed tools requested by this skill: ${skill.allowedTools.join(', ')}. For fork skills, the child agent tool registry is constrained to this whitelist while normal ${APP_NAME} tool permissions still apply.`
        : `Allowed tools requested by this skill: ${skill.allowedTools.join(', ')}. For inline skills, treat this as guidance; normal ${APP_NAME} tool permissions still apply.`
      : null,
    skill.paths?.length ? `Activation paths: ${skill.paths.join(', ')}` : null,
    skill.context === 'fork' && skill.subagentType ? `Preferred subagentType: ${skill.subagentType}` : null,
    args?.trim() ? `User-provided skill arguments:\n${args.trim()}` : null,
    `Skill directory: ${skillDirPosix}`,
    'If the skill body references bundled files or scripts, resolve relative paths against the skill directory above; ${SKILL_DIR} has already been expanded to that absolute path.',
    '',
    body,
    '</skill>',
    '',
    `Follow the skill instructions above for the current task. If the skill requires files or commands, use the normal ${APP_NAME} tools and permission flow.`
  ].filter((part): part is string => typeof part === 'string')

  return sections.join('\n')
}
