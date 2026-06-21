import { promises as fs } from 'fs'
import { join, basename } from 'path'
import { homedir, tmpdir } from 'os'
import { runCommand } from '../../services/headlessTerminal'
import { adaptSkillMarkdown } from './adaptSkill'
import { DATA_DIR_NAME, tmpName } from '@shared/appConfig'

export interface ResolvedSource {
  gitUrl: string
  subdir?: string
  label: string
  skillFilter?: string
}

export interface DiscoveredSkill {
  name: string
  skillMdPath: string
  dir: string
}

export interface InstalledSkill {
  name: string
  targetDir: string
  notes: string[]
  files: string[]
}

export interface InstallSkillResult {
  source: ResolvedSource
  installed: InstalledSkill[]
  available: string[]
  errors: string[]
}

const SKILL_CONTAINER_DIRS = ['', 'skills', '.claude/skills', '.agents/skills', '.cursor/skills']

export function resolveSkillSource(raw: string): ResolvedSource {
  let input = raw.trim()
  let skillFilter: string | undefined

  const isScpGit = /^git@/.test(input)
  const atIdx = input.lastIndexOf('@')
  if (atIdx > 0 && !isScpGit) {
    const candidate = input.slice(atIdx + 1)
    if (/^[\w.-]+$/.test(candidate)) {
      skillFilter = candidate
      input = input.slice(0, atIdx)
    }
  }

  const finalize = (src: ResolvedSource): ResolvedSource => {
    if (skillFilter) return { ...src, skillFilter, label: `${src.label}@${skillFilter}` }
    return src
  }

  const treeMatch = input.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/[^/]+\/(.+)$/i)
  if (treeMatch) {
    const [, owner, repo, sub] = treeMatch
    return finalize({ gitUrl: `https://github.com/${owner}/${repo}.git`, subdir: sub.replace(/\/+$/, ''), label: `${owner}/${repo}/${sub}` })
  }
  const ghUrl = input.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i)
  if (ghUrl) {
    const [, owner, repo] = ghUrl
    return finalize({ gitUrl: `https://github.com/${owner}/${repo}.git`, label: `${owner}/${repo}` })
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(input)) {
    return finalize({ gitUrl: `https://github.com/${input}.git`, label: input })
  }
  if (/^(https?:\/\/|git@)/.test(input)) {
    return finalize({ gitUrl: input, label: input })
  }
  return finalize({ gitUrl: input, label: input })
}

export function userSkillsInstallRoot(): string {
  return join(homedir(), DATA_DIR_NAME, 'skills')
}

async function cloneRepo(gitUrl: string, dest: string, signal?: AbortSignal): Promise<void> {
  const result = await runCommand(`git clone --depth 1 ${JSON.stringify(gitUrl)} ${JSON.stringify(dest)}`, {
    cwd: tmpdir(),
    timeoutMs: 120_000,
    signal
  })
  if (result.exitCode !== 0) {
    throw new Error(`git clone 失败 (exit ${result.exitCode}): ${result.stderr.slice(0, 500) || result.stdout.slice(0, 500)}`)
  }
}

async function tryRegisterSkill(
  found: Map<string, DiscoveredSkill>,
  dir: string,
  fallbackName: string
): Promise<boolean> {
  const skillMd = join(dir, 'SKILL.md')
  try {
    if (!(await fs.stat(skillMd)).isFile()) return false
  } catch {
    return false
  }
  const name = basename(dir) || fallbackName
  const key = name.toLowerCase()
  if (!found.has(key)) found.set(key, { name, skillMdPath: skillMd, dir })
  return true
}

async function findSkillMdDirs(root: string): Promise<DiscoveredSkill[]> {
  const found = new Map<string, DiscoveredSkill>()
  const containers = new Set<string>()
  for (const c of SKILL_CONTAINER_DIRS) containers.add(join(root, c))

  for (const container of containers) {
    let entries
    try {
      entries = await fs.readdir(container, { withFileTypes: true })
    } catch {
      continue
    }
    await tryRegisterSkill(found, container, basename(root))

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = join(container, entry.name)
      const isShallowSkill = await tryRegisterSkill(found, dir, entry.name)
      if (isShallowSkill) continue
      // Catalog layout: walk one extra level deep (e.g. skills/.curated/<name>/SKILL.md)
      let nested
      try {
        nested = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const child of nested) {
        if (!child.isDirectory()) continue
        await tryRegisterSkill(found, join(dir, child.name), child.name)
      }
    }
  }
  return [...found.values()]
}

async function copyAuxFiles(srcDir: string, destDir: string, skillMdName: string): Promise<string[]> {
  const copied: string[] = []
  const entries = await fs.readdir(srcDir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === skillMdName) continue
    const src = join(srcDir, entry.name)
    const dest = join(destDir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '.git') continue
      await fs.cp(src, dest, { recursive: true })
      copied.push(`${entry.name}/`)
    } else if (entry.isFile()) {
      await fs.copyFile(src, dest)
      copied.push(entry.name)
    }
  }
  return copied
}

export interface InstallSkillOptions {
  source: string
  skillNames?: string[]
  listOnly?: boolean
  signal?: AbortSignal
}

export async function installSkillFromSource(opts: InstallSkillOptions): Promise<InstallSkillResult> {
  const source = resolveSkillSource(opts.source)
  const errors: string[] = []
  const installed: InstalledSkill[] = []

  const work = await fs.mkdtemp(join(tmpdir(), `${tmpName('skill-install')}-`))
  const cloneDir = join(work, 'repo')
  try {
    await cloneRepo(source.gitUrl, cloneDir, opts.signal)

    const searchRoot = source.subdir ? join(cloneDir, source.subdir) : cloneDir
    let discovered = await findSkillMdDirs(searchRoot)
    if (discovered.length === 0 && source.subdir) {
      discovered = await findSkillMdDirs(cloneDir)
    }

    const available = discovered.map((d) => d.name).sort()
    if (opts.listOnly) {
      return { source, installed: [], available, errors }
    }

    const explicitNames = opts.skillNames && opts.skillNames.length > 0
      ? opts.skillNames
      : source.skillFilter
        ? [source.skillFilter]
        : undefined

    let selected = discovered
    if (explicitNames && !explicitNames.includes('*')) {
      const wanted = new Set(explicitNames.map((s) => s.toLowerCase()))
      selected = discovered.filter((d) => wanted.has(d.name.toLowerCase()))
      for (const name of explicitNames) {
        if (!discovered.some((d) => d.name.toLowerCase() === name.toLowerCase())) {
          errors.push(`未在该源中找到 skill: ${name}（可用: ${available.join(', ') || '无'}）`)
        }
      }
    }

    if (selected.length === 0) {
      return { source, installed: [], available, errors }
    }

    const installRoot = userSkillsInstallRoot()
    await fs.mkdir(installRoot, { recursive: true })

    for (const skill of selected) {
      try {
        const markdown = await fs.readFile(skill.skillMdPath, 'utf8')
        const adapted = adaptSkillMarkdown(markdown, { sourceRepo: source.label, skillNameHint: skill.name })
        const targetDir = join(installRoot, skill.name)
        await fs.mkdir(targetDir, { recursive: true })
        await fs.writeFile(join(targetDir, 'SKILL.md'), adapted.content, 'utf8')
        const aux = await copyAuxFiles(skill.dir, targetDir, basename(skill.skillMdPath))
        installed.push({ name: skill.name, targetDir, notes: adapted.notes, files: ['SKILL.md', ...aux] })
      } catch (e) {
        errors.push(`安装 ${skill.name} 失败: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    return { source, installed, available, errors }
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => undefined)
  }
}
