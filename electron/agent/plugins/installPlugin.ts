import { promises as fs, existsSync } from 'fs'
import { join, basename, isAbsolute, resolve as pathResolve, delimiter } from 'path'
import { homedir, tmpdir } from 'os'
import { runCommand } from '../../services/headlessTerminal'
import { resolveSkillSource } from '../skills/installSkill'
import { adaptSkillMarkdown } from '../skills/adaptSkill'
import { getMcpSettings, saveMcpSettings, getAgentBehaviorSettings } from '../settings/agentSettingsStore'
import { parsePluginManifest, PLUGIN_MANIFEST_PATHS, isSafePluginName, pluginMcpServerName, type PluginManifest } from '@shared/pluginTypes'
import type { PluginInstallRecord, InstalledPluginInfo } from '@shared/pluginTypes'
import {
  parseMcpJsonFile,
  normalizeServerConfig,
  isStdioConfig,
  MCP_SERVER_NAME_PATTERN,
  type McpServerConfig
} from '@shared/mcpTypes'
import { DATA_DIR_NAME, tmpName } from '@shared/appConfig'

// 安装记录文件名（位于各插件安装目录内）。
const PLUGIN_RECORD_FILE = '.codelf-plugin.json'

// 用户级插件安装根：~/.codelf/plugins
export function userPluginsInstallRoot(): string {
  return join(homedir(), DATA_DIR_NAME, 'plugins')
}

// 某个已安装插件内的 skills 根：~/.codelf/plugins/<name>/skills
export function pluginSkillsRoot(pluginName: string): string {
  return join(userPluginsInstallRoot(), pluginName, 'skills')
}

// 校验目标目录确实是安装根的直接子目录（防止 name 含 ../ 等导致逃逸）。
// 校验通过返回归一化后的安装目录绝对路径，否则抛错。
function resolveSafeInstallDir(pluginName: string): string {
  const root = pathResolve(userPluginsInstallRoot())
  const installDir = pathResolve(root, pluginName)
  const sep = process.platform === 'win32' ? '\\' : '/'
  if (!installDir.startsWith(root + sep)) {
    throw new Error(`非法的插件名（路径逃逸）: ${pluginName}`)
  }
  // 必须是 root 的「直接」子目录，不能再嵌套层级。
  const rel = installDir.slice(root.length + sep.length)
  if (rel.includes('/') || rel.includes('\\')) {
    throw new Error(`非法的插件名（含路径分隔符）: ${pluginName}`)
  }
  return installDir
}

export interface InstalledPluginSkill {
  name: string
  targetDir: string
  notes: string[]
}

export interface InstalledPluginMcp {
  name: string
  config: McpServerConfig
}

export interface InstallPluginResult {
  pluginName: string
  version?: string
  description?: string
  installDir: string
  sourceLabel: string
  gitUrl: string
  skills: InstalledPluginSkill[]
  mcpServers: InstalledPluginMcp[]
  errors: string[]
  notes: string[]
}

export interface InstallPluginOptions {
  source: string
  signal?: AbortSignal
  // 分步进度回调（clone / 解析 / 安装 skills / 注册 MCP / npm install 等）。
  onProgress?: (stage: import('@shared/pluginTypes').PluginInstallStage, message: string) => void
}

// 把插件解析出的 MCP servers 写入 user 级配置（覆盖式合并）。
// 返回实际写入的 server 名列表。调用方应随后触发 reloadAndResync 以热加载。
export function persistPluginMcpServers(servers: InstalledPluginMcp[]): string[] {
  if (servers.length === 0) return []
  const current = getMcpSettings()
  const merged = { ...current.servers }
  for (const server of servers) {
    merged[server.name] = { config: server.config, enabled: true }
  }
  saveMcpSettings({ ...current, servers: merged })
  return servers.map((s) => s.name)
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

async function readJsonFile(filePath: string): Promise<unknown> {
  const raw = await fs.readFile(filePath, 'utf8')
  return JSON.parse(raw)
}

// 在克隆目录中查找并解析插件清单，返回清单及其所在目录（用于解析相对路径）。
async function findManifest(repoRoot: string): Promise<{ manifest: PluginManifest; manifestDir: string } | null> {
  for (const rel of PLUGIN_MANIFEST_PATHS) {
    const file = join(repoRoot, rel)
    try {
      const stat = await fs.stat(file)
      if (!stat.isFile()) continue
      const manifest = parsePluginManifest(await readJsonFile(file))
      if (manifest) return { manifest, manifestDir: repoRoot }
    } catch {
      // 文件不存在或解析失败，尝试下一个候选路径
    }
  }
  return null
}

// 定位本机 git-bash（用于在 Windows 上执行插件自带的 .sh 启动脚本）。
// 优先 GIT_BASH 环境变量，其次从 PATH 中的 git 推导，最后回退常见安装路径。
function findGitBash(): string | null {
  const envBash = process.env.GIT_BASH
  if (envBash && existsSyncSafe(envBash)) return envBash

  const candidates: string[] = []
  const pathEntries = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const dir of pathEntries) {
    const lower = dir.toLowerCase()
    if (!lower.includes('git')) continue
    // PATH 里通常是 <gitRoot>\cmd 或 <gitRoot>\bin；bash 在 <gitRoot>\bin\bash.exe。
    const gitRoot = pathResolve(dir, '..')
    candidates.push(join(gitRoot, 'bin', 'bash.exe'))
    candidates.push(join(dir, 'bash.exe'))
  }
  candidates.push(
    'C:/Program Files/Git/bin/bash.exe',
    'C:/Program Files (x86)/Git/bin/bash.exe',
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'bin', 'bash.exe')
  )
  for (const c of candidates) {
    if (c && existsSyncSafe(c)) return c
  }
  return null
}

function existsSyncSafe(p: string): boolean {
  try {
    return existsSync(p)
  } catch {
    return false
  }
}

// 复制目录（排除 .git），用于把插件本体落到安装目录。
async function copyTree(src: string, dest: string): Promise<void> {
  await fs.cp(src, dest, {
    recursive: true,
    filter: (source) => basename(source) !== '.git'
  })
}

// 把 Codex 专属内容做转换/标注，使 skill 在 Codelf 下可用。
// 返回适配后的正文与适配说明。
function adaptPluginSkillBody(
  markdown: string,
  opts: { pluginName: string; installDir: string; pluginRoot: string }
): { content: string; notes: string[] } {
  const notes: string[] = []
  let body = markdown
  const installPosix = opts.installDir.replace(/\\/g, '/')
  const pluginRootPosix = opts.pluginRoot.replace(/\\/g, '/')

  // 1) 相对脚本路径（./scripts/xxx.sh、./mcp/xxx.mjs）锚定到插件「安装根目录」。
  //    注意：scripts/mcp/bin 目录位于插件根，而非各 skill 子目录，故用 pluginRoot。
  if (/(^|[\s`(])\.\/(scripts|mcp|bin)\//m.test(body)) {
    body = body.replace(/(^|[\s`(])\.\/(scripts|mcp|bin)\//gm, `$1${pluginRootPosix}/$2/`)
    notes.push('已将相对脚本路径（./scripts 等）锚定到插件安装目录。')
  }

  // 1b) 修正历史/错误锚定：把指向 skills/<name>/scripts 的脚本路径纠正到插件根 scripts。
  const skillScriptsWrong = `${installPosix}/scripts/`
  if (body.includes(skillScriptsWrong) && installPosix !== pluginRootPosix) {
    body = body.split(skillScriptsWrong).join(`${pluginRootPosix}/scripts/`)
    notes.push('已修正脚本路径：scripts 目录位于插件根而非 skill 子目录。')
  }

  // 1c) Windows 无 bash：把 `<path>/xxx.sh` 调用改写为 `bash "<path>/xxx.sh"`（定位到 git-bash）。
  if (process.platform === 'win32' && /[^\s`"']+\.sh\b/.test(body)) {
    const gitBash = findGitBash()
    const bashCmd = gitBash ? `"${gitBash.replace(/\\/g, '/')}"` : 'bash'
    // 仅改写「行首/代码块内」以 .sh 路径起头的命令行，避免误伤说明性文字。
    body = body.replace(/(^|\n)([ \t]*)((?:[A-Za-z]:)?[^\s`"'\n]+\.sh)\b/g, (_m, lead, indent, scriptPath) => {
      return `${lead}${indent}${bashCmd} "${scriptPath}"`
    })
    notes.push(
      gitBash
        ? `Windows 适配：.sh 启动脚本已改为通过 git-bash 执行（${gitBash}）。`
        : 'Windows 适配：.sh 启动脚本已加 bash 前缀；若未安装 git-bash，请设置 GIT_BASH 环境变量或手动用 WSL/bash 运行。'
    )
  }

  // 2) Codex 项目目录占位 → 描述性说明（运行时由 Agent 用当前工作区填充）。
  if (/\/path\/to\/user\/(codex-)?project/.test(body)) {
    body = body.replace(/\/path\/to\/user\/(codex-)?project/g, '<当前 Codelf 工作区根目录>')
    notes.push('已将 /path/to/user/codex-project 占位替换为「当前工作区根目录」说明。')
  }

  const adaptationNotes: string[] = []
  // 3) Codex in-app browser bootstrap：Codelf 用自有内置浏览器，无法机械替换原文代码。
  if (/CODEX_HOME|node_repl|browser-client|openai-bundled/.test(body)) {
    adaptationNotes.push(
      '- 本 skill 原文引用了 Codex 专属的 in-app browser 启动流程（CODEX_HOME / node_repl / browser-client / openai-bundled）。在 Codelf 中请忽略那段 Node REPL bootstrap 代码，改为直接调用 `OpenInAppBrowser` 工具并传入本地 URL（如 http://127.0.0.1:PORT），页面会在 Codelf 内置浏览器标签中打开给用户，且支持 localhost。若只是需要 agent 读取/自动操作页面，则改用 Browser*（Playwright）工具组。'
    )
  }
  // 4) Codex 内置 imagegen / 会话 JSONL：Codelf 暂无对应能力。
  if (/\bimagegen\b|generated_images|session JSONL/i.test(body)) {
    adaptationNotes.push(
      '- 本 skill 依赖 Codex 内置的图像生成（imagegen）与 $CODEX_HOME/generated_images 目录。Codelf 暂无内置图像生成工具：若无可用的图像生成 MCP，请让用户提供本地图片路径，或跳过生成步骤。'
    )
  }

  if (adaptationNotes.length > 0) {
    const banner = [
      '',
      '> [!NOTE] Codelf 适配说明',
      '> 本插件原为 Codex 编写，以下内容在 Codelf 下需调整：',
      ...adaptationNotes.map((n) => `> ${n.slice(2)}`),
      ''
    ].join('\n')
    body = `${banner}\n${body}`
    notes.push(`注入了 ${adaptationNotes.length} 条 Codex→Codelf 适配说明。`)
  }

  return { content: body, notes }
}

// 解析插件 skills 目录下的所有 SKILL.md，适配后写入安装目录。
async function installPluginSkills(
  installDir: string,
  skillsDir: string,
  sourceLabel: string,
  pluginName: string,
  errors: string[]
): Promise<InstalledPluginSkill[]> {
  const root = join(installDir, skillsDir)
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }

  const installed: InstalledPluginSkill[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    const skillMd = join(dir, 'SKILL.md')
    try {
      if (!(await fs.stat(skillMd)).isFile()) continue
    } catch {
      continue
    }
    try {
      const markdown = await fs.readFile(skillMd, 'utf8')
      // 先做 Codex→Codelf 正文适配，再做通用 frontmatter/工具名归一化。
      const bodyAdapted = adaptPluginSkillBody(markdown, { pluginName, installDir: dir, pluginRoot: installDir })
      const adapted = adaptSkillMarkdown(bodyAdapted.content, { sourceRepo: sourceLabel, skillNameHint: entry.name })
      await fs.writeFile(skillMd, adapted.content, 'utf8')
      installed.push({ name: entry.name, targetDir: dir, notes: [...bodyAdapted.notes, ...adapted.notes] })
    } catch (e) {
      errors.push(`适配 skill ${entry.name} 失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return installed
}

// 把相对路径锚定到插件安装目录（保持绝对路径不变）。
function anchorPath(value: string, installDir: string): string {
  if (!value || value === '.') return installDir
  if (isAbsolute(value)) return value
  return pathResolve(installDir, value)
}

// 从 shell 启动脚本中提取真正的 node 入口（如 `exec node ./mcp/server.mjs`）。
// 返回入口文件相对脚本所在目录上一级（脚本约定 cd ROOT_DIR=dirname/..）的解析结果，失败返回 null。
async function extractNodeEntryFromScript(scriptPath: string): Promise<string | null> {
  let content: string
  try {
    content = await fs.readFile(scriptPath, 'utf8')
  } catch {
    return null
  }
  // 匹配 `node <entry>` 或 `exec node <entry>`（忽略 npm/npx 之类，无法直接定位入口）。
  const match = content.match(/(?:^|\n)\s*(?:exec\s+)?node\s+(?:--[\w-]+\s+)*["']?([^\s"';]+\.(?:mjs|cjs|js))["']?/)
  if (!match) return null
  const entry = match[1]
  if (isAbsolute(entry)) return entry
  // 脚本通常 `cd "$(dirname ...)/.."` 后运行，故入口相对脚本目录的上一级解析。
  const scriptDir = pathResolve(scriptPath, '..')
  const rootDir = pathResolve(scriptDir, '..')
  return pathResolve(rootDir, entry)
}

// 把插件声明的 MCP server 配置重写为可在 Codelf 直接运行的形态：
// - bash/sh 启动脚本 → 提取 node 入口直启（跨平台，规避 Windows 无 bash）
// - stdio command / args 中的相对脚本路径锚定到安装目录
// 输入为原始配置对象（含可能的 cwd 字段），输出为归一化前的 stdio 配置。
interface RawStdioEntry {
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

async function rewriteStdioEntry(entry: RawStdioEntry, installDir: string): Promise<RawStdioEntry> {
  const cwdAbs = entry.cwd ? anchorPath(entry.cwd, installDir) : installDir
  const args = entry.args ?? []
  const cmdLower = entry.command.toLowerCase()
  const isShellRunner = cmdLower === 'bash' || cmdLower === 'sh' || cmdLower.endsWith('/bash') || cmdLower.endsWith('/sh')
  const firstArg = args[0]

  // bash ./scripts/start-mcp.sh → 尝试提取 node 入口直启。
  if (isShellRunner && typeof firstArg === 'string' && firstArg.endsWith('.sh')) {
    const scriptPath = anchorPath(firstArg, cwdAbs)
    const nodeEntry = await extractNodeEntryFromScript(scriptPath)
    if (nodeEntry) {
      return {
        command: 'node',
        args: [nodeEntry, ...args.slice(1)],
        env: entry.env,
        cwd: cwdAbs
      }
    }
  }

  // 普通命令：相对脚本路径的 command 与 args 锚定到安装目录。
  const rewrittenCommand =
    /[\\/]/.test(entry.command) && !isAbsolute(entry.command) ? anchorPath(entry.command, cwdAbs) : entry.command
  const rewrittenArgs = args.map((a) =>
    typeof a === 'string' && /[\\/]/.test(a) && !isAbsolute(a) && /\.(mjs|cjs|js|sh|py)$/.test(a)
      ? anchorPath(a, cwdAbs)
      : a
  )
  return { command: rewrittenCommand, args: rewrittenArgs, env: entry.env, cwd: cwdAbs }
}

// 从清单解析出待注册的 MCP server 列表（内联优先，其次 .mcp.json 引用）。
async function resolvePluginMcpServers(
  manifest: PluginManifest,
  installDir: string,
  errors: string[]
): Promise<InstalledPluginMcp[]> {
  const collected: Record<string, McpServerConfig> = {}

  if (manifest.mcpServersInline) {
    for (const [name, config] of Object.entries(manifest.mcpServersInline)) {
      collected[name] = config
    }
  }

  if (manifest.mcpServersRef) {
    const refFile = anchorPath(manifest.mcpServersRef, installDir)
    try {
      const parsed = parseMcpJsonFile(await readJsonFile(refFile))
      for (const [name, config] of Object.entries(parsed)) {
        collected[name] = config
      }
    } catch (e) {
      errors.push(`读取 mcpServers 引用 ${manifest.mcpServersRef} 失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const out: InstalledPluginMcp[] = []
  for (const [name, config] of Object.entries(collected)) {
    if (!MCP_SERVER_NAME_PATTERN.test(name)) {
      errors.push(`MCP server 名非法，已跳过: ${name}`)
      continue
    }
    // 加插件命名空间，避免与用户/其它插件的同名 server 互相覆盖。
    const namespaced = pluginMcpServerName(manifest.name, name)
    if (!MCP_SERVER_NAME_PATTERN.test(namespaced)) {
      errors.push(`MCP server 命名空间名非法，已跳过: ${name}`)
      continue
    }
    // stdio：做 bash→node 改写与路径锚定；http/sse 原样保留。
    let rewritten: McpServerConfig
    if (isStdioConfig(config)) {
      const entry = await rewriteStdioEntry(
        { command: config.command, args: config.args, env: config.env, cwd: config.cwd },
        installDir
      )
      rewritten = { type: 'stdio', command: entry.command, args: entry.args, env: entry.env, cwd: entry.cwd }
    } else {
      rewritten = config
    }
    const normalized = normalizeServerConfig(rewritten)
    if (!normalized) {
      errors.push(`MCP server 配置无效，已跳过: ${name}`)
      continue
    }
    out.push({ name: namespaced, config: normalized })
  }
  return out
}

// 若插件根含 package.json，自动安装依赖（并在有 build 脚本时构建）。
// 失败不抛错，只记录 note，让用户可手动补做。
async function buildPluginDependencies(
  installDir: string,
  notes: string[],
  signal?: AbortSignal,
  onProgress?: (stage: import('@shared/pluginTypes').PluginInstallStage, message: string) => void
): Promise<void> {
  const pkgPath = join(installDir, 'package.json')
  let pkg: { scripts?: Record<string, string> }
  try {
    pkg = (await readJsonFile(pkgPath)) as { scripts?: Record<string, string> }
  } catch {
    return
  }

  // 供应链风险门控：未开启「允许自动 npm install」时不执行任意仓库脚本，仅提示。
  if (!getAgentBehaviorSettings().pluginAllowNpmInstall) {
    notes.push(
      `检测到 package.json：出于安全未自动执行 npm install（会运行仓库脚本）。如需运行其 MCP server，请在设置中开启「允许插件自动安装依赖」，或手动在 ${installDir} 执行 npm install。`
    )
    return
  }

  onProgress?.('deps', '正在安装插件依赖（npm install，可能需要一两分钟）…')
  const install = await runCommand('npm install', { cwd: installDir, timeoutMs: 300_000, signal })
  if (install.exitCode !== 0) {
    notes.push(`npm install 失败（exit ${install.exitCode}），如需 MCP server 运行请手动在 ${installDir} 执行 npm install。`)
    return
  }

  if (pkg.scripts && typeof pkg.scripts.build === 'string') {
    onProgress?.('deps', '正在构建插件（npm run build）…')
    const build = await runCommand('npm run build', { cwd: installDir, timeoutMs: 300_000, signal })
    if (build.exitCode !== 0) {
      notes.push(`npm run build 失败（exit ${build.exitCode}），如需可手动在 ${installDir} 执行 npm run build。`)
    }
  }
}

// 安装入口：克隆插件仓库，解析清单，安装 skills 并解析 MCP servers。
// 注意：本函数只负责落盘与解析；把 MCP 写入 settings 的动作由调用方（IPC/工具）完成，
// 以便复用现有的 saveMcpSettings + reloadAndResync 热加载链路。
export async function installPluginFromSource(opts: InstallPluginOptions): Promise<InstallPluginResult> {
  const source = resolveSkillSource(opts.source)
  const errors: string[] = []
  const notes: string[] = []
  const report = opts.onProgress ?? ((): void => undefined)

  const work = await fs.mkdtemp(join(tmpdir(), `${tmpName('plugin-install')}-`))
  const cloneDir = join(work, 'repo')
  try {
    report('clone', `正在克隆仓库 ${source.label}…`)
    await cloneRepo(source.gitUrl, cloneDir, opts.signal)

    report('manifest', '正在解析插件清单…')
    const found = await findManifest(cloneDir)
    if (!found) {
      throw new Error('未找到插件清单（.codex-plugin/plugin.json 或 .claude-plugin/plugin.json）')
    }
    const { manifest } = found
    // 纵深防御：即便清单解析已校验名字，这里再确认目标目录不会逃逸出安装根。
    if (!isSafePluginName(manifest.name)) {
      throw new Error(`非法的插件名: ${manifest.name}`)
    }

    const installRoot = userPluginsInstallRoot()
    await fs.mkdir(installRoot, { recursive: true })
    const installDir = resolveSafeInstallDir(manifest.name)
    // 覆盖式安装：先清掉旧目录，避免残留。
    await fs.rm(installDir, { recursive: true, force: true }).catch(() => undefined)
    report('copy', `正在复制插件文件到 ${installDir}…`)
    await copyTree(cloneDir, installDir)

    report('skills', '正在安装并适配技能…')
    const skills = manifest.skillsDir
      ? await installPluginSkills(installDir, manifest.skillsDir, source.label, manifest.name, errors)
      : []
    if (manifest.skillsDir && skills.length === 0) {
      notes.push(`清单声明了 skills 目录（${manifest.skillsDir}）但未发现可用 SKILL.md。`)
    }

    report('mcp', '正在解析 MCP 服务配置…')
    const mcpServers = await resolvePluginMcpServers(manifest, installDir, errors)

    // 有 MCP server 的插件通常需要本地依赖才能启动；自动构建。
    if (mcpServers.length > 0) {
      await buildPluginDependencies(installDir, notes, opts.signal, opts.onProgress)
    }

    report('finalize', '正在写入安装记录…')
    // 写入安装记录，供「插件管理」列出与卸载联动。
    const record: PluginInstallRecord = {
      pluginName: manifest.name,
      version: manifest.version,
      description: manifest.description,
      sourceLabel: source.label,
      gitUrl: source.gitUrl,
      installedAt: new Date().toISOString(),
      skills: skills.map((s) => s.name),
      mcpServers: mcpServers.map((s) => s.name)
    }
    await fs.writeFile(join(installDir, PLUGIN_RECORD_FILE), JSON.stringify(record, null, 2), 'utf8').catch(() => undefined)

    return {
      pluginName: manifest.name,
      version: manifest.version,
      description: manifest.description,
      installDir,
      sourceLabel: source.label,
      gitUrl: source.gitUrl,
      skills,
      mcpServers,
      errors,
      notes
    }
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => undefined)
  }
}

// 列出 ~/.codelf/plugins 下所有已安装插件（读取各自的安装记录）。
export async function listInstalledPlugins(): Promise<InstalledPluginInfo[]> {
  const root = userPluginsInstallRoot()
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }

  const out: InstalledPluginInfo[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const installDir = join(root, entry.name)
    let record: PluginInstallRecord | null = null
    try {
      record = (await readJsonFile(join(installDir, PLUGIN_RECORD_FILE))) as PluginInstallRecord
    } catch {
      // 无记录文件：可能是手动放置的插件目录，给出最小信息。
    }
    out.push({
      pluginName: record?.pluginName ?? entry.name,
      version: record?.version,
      description: record?.description,
      sourceLabel: record?.sourceLabel,
      gitUrl: record?.gitUrl,
      installedAt: record?.installedAt ?? '',
      skills: record?.skills ?? [],
      mcpServers: record?.mcpServers ?? [],
      installDir
    })
  }
  return out.sort((a, b) => a.pluginName.localeCompare(b.pluginName))
}

// 卸载插件：删除安装目录，并从 user 级 MCP 配置中移除其注册的 server。
// 返回被移除的 MCP server 名（供调用方触发 reloadAndResync）。
export async function uninstallPlugin(pluginName: string): Promise<string[]> {
  // 安全限制：只允许删除安装根的直接子目录（防止 ../ 逃逸）。
  const installDir = resolveSafeInstallDir(pluginName)

  let record: PluginInstallRecord | null = null
  try {
    record = (await readJsonFile(join(installDir, PLUGIN_RECORD_FILE))) as PluginInstallRecord
  } catch {
    // 无记录则只删目录。
  }

  const removedServers = record?.mcpServers ?? []
  if (removedServers.length > 0) {
    const current = getMcpSettings()
    const servers = { ...current.servers }
    for (const name of removedServers) delete servers[name]
    saveMcpSettings({ ...current, servers })
  }

  await fs.rm(installDir, { recursive: true, force: true })
  return removedServers
}
