import { runCommand } from './headlessTerminal'
import { join, isAbsolute, extname } from 'path'
import type {
  GitStatus,
  GitFileChange,
  GitFileStatus,
  GitDiffContent,
  GitBranch,
  GitOpResult,
  GitCommitResult
} from '@shared/gitTypes'

interface RawResult {
  ok: boolean
  stdout: string
  stderr: string
}

async function runGit(
  cwd: string,
  args: string[],
  signal?: AbortSignal,
  timeoutMs = 15_000
): Promise<RawResult> {
  try {
    const res = await runCommand(`git ${args.map(shellQuote).join(' ')}`, {
      cwd,
      timeoutMs,
      signal
    })
    return { ok: res.exitCode === 0, stdout: res.stdout, stderr: res.stderr }
  } catch (e) {
    return { ok: false, stdout: '', stderr: e instanceof Error ? e.message : String(e) }
  }
}

const NETWORK_TIMEOUT_MS = 120_000

function shellQuote(arg: string): string {
  if (/^[\w./=:@-]+$/.test(arg)) return arg
  if (process.platform === 'win32') {
    
    return `'${arg.replace(/'/g, "''")}'`
  }
  
  return `'${arg.replace(/'/g, "'\\''")}'`
}

export async function isGitRepo(cwd: string, signal?: AbortSignal): Promise<boolean> {
  const res = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'], signal)
  return res.ok && /^true\s*$/i.test(res.stdout.trim())
}

async function repoRoot(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
  const res = await runGit(cwd, ['rev-parse', '--show-toplevel'], signal)
  if (!res.ok) return undefined
  const root = res.stdout.trim()
  return root || undefined
}

function mapStatusCode(code: string): GitFileStatus {
  switch (code) {
    case 'M':
      return 'modified'
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    case '?':
      return 'untracked'
    case 'U':
      return 'conflicted'
    default:
      return 'unknown'
  }
}

function parsePorcelainPath(raw: string): { path: string; orig?: string } {
  
  const arrow = raw.indexOf(' -> ')
  if (arrow !== -1) {
    return { orig: raw.slice(0, arrow), path: raw.slice(arrow + 4) }
  }
  return { path: raw }
}

function unquote(p: string): string {
  
  if (p.startsWith('"') && p.endsWith('"')) {
    try {
      return p
        .slice(1, -1)
        .replace(/\\([\\"])/g, '$1')
        .replace(/\\(\d{3})/g, (_m, oct: string) => String.fromCharCode(parseInt(oct, 8)))
    } catch {
      return p.slice(1, -1)
    }
  }
  return p
}

export async function getStatus(cwd: string, signal?: AbortSignal): Promise<GitStatus> {
  if (!(await isGitRepo(cwd, signal))) return { isRepo: false, staged: [], unstaged: [] }
  const root = (await repoRoot(cwd, signal)) ?? cwd

  const res = await runGit(
    root,
    ['-c', 'core.quotePath=false', 'status', '--porcelain=v1', '--branch', '--untracked-files=all'],
    signal
  )
  if (!res.ok) return { isRepo: true, root, staged: [], unstaged: [] }

  const staged: GitFileChange[] = []
  const unstaged: GitFileChange[] = []
  let branch: string | undefined
  let detached = false
  let ahead: number | undefined
  let behind: number | undefined
  let hasUpstream = false

  for (const line of res.stdout.split(/\r?\n/)) {
    if (!line) continue
    if (line.startsWith('##')) {
      const info = parseBranchLine(line.slice(2).trim())
      branch = info.branch
      detached = info.detached
      ahead = info.ahead
      behind = info.behind
      hasUpstream = info.hasUpstream
      continue
    }
    const x = line[0]
    const y = line[1]
    const rest = unquote(line.slice(3))
    const { path: p, orig } = parsePorcelainPath(rest)

    if (x === '?' && y === '?') {
      unstaged.push({ path: p, displayPath: p, status: 'untracked', staged: false })
      continue
    }
    if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) {
      unstaged.push({ path: p, displayPath: p, origPath: orig, status: 'conflicted', staged: false })
      continue
    }
    if (x !== ' ' && x !== '?') {
      staged.push({ path: p, displayPath: p, origPath: orig, status: mapStatusCode(x), staged: true })
    }
    if (y !== ' ' && y !== '?') {
      unstaged.push({ path: p, displayPath: p, origPath: orig, status: mapStatusCode(y), staged: false })
    }
  }

  return { isRepo: true, root, branch, detached, ahead, behind, hasUpstream, staged, unstaged }
}

function parseBranchLine(line: string): {
  branch?: string
  detached: boolean
  ahead?: number
  behind?: number
  hasUpstream: boolean
} {
  
  if (line.startsWith('No commits yet on ')) {
    return { branch: line.slice('No commits yet on '.length).trim(), detached: false, hasUpstream: false }
  }
  if (line.startsWith('HEAD (no branch)')) {
    return { detached: true, hasUpstream: false }
  }
  
  const head = line.split('...')[0].trim()
  const hasUpstream = line.includes('...')
  let ahead: number | undefined
  let behind: number | undefined
  const track = /\[(.+)\]\s*$/.exec(line)
  if (track) {
    const a = /ahead (\d+)/.exec(track[1])
    const b = /behind (\d+)/.exec(track[1])
    if (a) ahead = Number(a[1])
    if (b) behind = Number(b[1])
  }
  return { branch: head || undefined, detached: false, ahead, behind, hasUpstream }
}

function resolveAbs(root: string, p: string): string {
  return isAbsolute(p) ? p : join(root, p)
}

const LANG_BY_EXT: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.json': 'json',
  '.css': 'css',
  '.scss': 'scss',
  '.html': 'html',
  '.md': 'markdown',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'cpp',
  '.sh': 'shell',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.xml': 'xml'
}

function langFor(path: string): string {
  return LANG_BY_EXT[extname(path).toLowerCase()] ?? 'plaintext'
}

/** Returns the "original" (committed/index) and "modified" (working/index) contents for a diff view. */
export async function getDiffContent(
  cwd: string,
  filePath: string,
  staged: boolean,
  signal?: AbortSignal
): Promise<GitDiffContent> {
  const root = (await repoRoot(cwd, signal)) ?? cwd
  const rel = filePath
  const language = langFor(filePath)

  if (staged) {
    
    const original = await showBlob(root, `HEAD:${rel}`, signal)
    const modified = await showBlob(root, `:${rel}`, signal)
    return { ok: true, original: original.content, modified: modified.content, language }
  }

  
  const indexBlob = await showBlob(root, `:${rel}`, signal)
  const original = indexBlob.ok ? indexBlob.content : (await showBlob(root, `HEAD:${rel}`, signal)).content
  const working = await readWorking(root, rel)
  return { ok: true, original, modified: working, language }
}

async function showBlob(
  root: string,
  spec: string,
  signal?: AbortSignal
): Promise<{ ok: boolean; content: string }> {
  const res = await runGit(root, ['show', spec], signal)
  return { ok: res.ok, content: res.ok ? res.stdout : '' }
}

async function readWorking(root: string, rel: string): Promise<string> {
  try {
    const { promises: fs } = await import('fs')
    return await fs.readFile(resolveAbs(root, rel), 'utf8')
  } catch {
    return ''
  }
}

export async function stage(cwd: string, paths: string[], signal?: AbortSignal): Promise<GitOpResult> {
  const root = (await repoRoot(cwd, signal)) ?? cwd
  const res = await runGit(root, ['add', '--', ...paths], signal)
  return { ok: res.ok, error: res.ok ? undefined : res.stderr.trim() || '暂存失败' }
}

export async function unstage(cwd: string, paths: string[], signal?: AbortSignal): Promise<GitOpResult> {
  const root = (await repoRoot(cwd, signal)) ?? cwd
  const res = await runGit(root, ['reset', '-q', 'HEAD', '--', ...paths], signal)
  return { ok: res.ok, error: res.ok ? undefined : res.stderr.trim() || '取消暂存失败' }
}

export async function stageAll(cwd: string, signal?: AbortSignal): Promise<GitOpResult> {
  const root = (await repoRoot(cwd, signal)) ?? cwd
  const res = await runGit(root, ['add', '-A'], signal)
  return { ok: res.ok, error: res.ok ? undefined : res.stderr.trim() || '暂存失败' }
}

export async function unstageAll(cwd: string, signal?: AbortSignal): Promise<GitOpResult> {
  const root = (await repoRoot(cwd, signal)) ?? cwd
  const res = await runGit(root, ['reset', '-q', 'HEAD', '--'], signal)
  return { ok: res.ok, error: res.ok ? undefined : res.stderr.trim() || '取消暂存失败' }
}

export async function discardChanges(
  cwd: string,
  change: { path: string; status: GitFileStatus },
  signal?: AbortSignal
): Promise<GitOpResult> {
  const root = (await repoRoot(cwd, signal)) ?? cwd
  if (change.status === 'untracked') {
    
    try {
      const { promises: fs } = await import('fs')
      await fs.rm(resolveAbs(root, change.path), { force: true })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : '删除失败' }
    }
  }
  const res = await runGit(root, ['checkout', 'HEAD', '--', change.path], signal)
  if (res.ok) return { ok: true }
  
  const res2 = await runGit(root, ['checkout', '--', change.path], signal)
  return { ok: res2.ok, error: res2.ok ? undefined : res2.stderr.trim() || '放弃更改失败' }
}

export async function commit(
  cwd: string,
  message: string,
  amend: boolean,
  signal?: AbortSignal
): Promise<GitCommitResult> {
  const root = (await repoRoot(cwd, signal)) ?? cwd
  const trimmed = message.trim()
  if (!trimmed && !amend) return { ok: false, error: '提交信息不能为空' }
  let args: string[]
  if (amend) {
    
    args = trimmed ? ['commit', '--amend', '-m', trimmed] : ['commit', '--amend', '--no-edit']
  } else {
    args = ['commit', '-m', trimmed]
  }
  const res = await runGit(root, args, signal)
  if (!res.ok) return { ok: false, error: res.stderr.trim() || res.stdout.trim() || '提交失败' }
  const head = await runGit(root, ['rev-parse', '--short', 'HEAD'], signal)
  return { ok: true, hash: head.ok ? head.stdout.trim() : undefined }
}

export async function listBranches(cwd: string, signal?: AbortSignal): Promise<GitBranch[]> {
  const root = (await repoRoot(cwd, signal)) ?? cwd
  const res = await runGit(root, ['branch', '--list', '--format=%(HEAD)%(refname:short)'], signal)
  if (!res.ok) return []
  const out: GitBranch[] = []
  for (const line of res.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    const current = line.startsWith('*')
    const name = line.replace(/^\*/, '').trim()
    if (name) out.push({ name, current })
  }
  return out
}

export async function checkoutBranch(
  cwd: string,
  name: string,
  create: boolean,
  signal?: AbortSignal
): Promise<GitOpResult> {
  const root = (await repoRoot(cwd, signal)) ?? cwd
  const args = create ? ['checkout', '-b', name] : ['checkout', name]
  const res = await runGit(root, args, signal)
  return { ok: res.ok, error: res.ok ? undefined : res.stderr.trim() || '切换分支失败' }
}

export async function push(cwd: string, signal?: AbortSignal): Promise<GitOpResult> {
  const root = (await repoRoot(cwd, signal)) ?? cwd
  
  const upstream = await runGit(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], signal)
  let res: RawResult
  if (upstream.ok) {
    res = await runGit(root, ['push'], signal, NETWORK_TIMEOUT_MS)
  } else {
    const branch = await runGit(root, ['symbolic-ref', '--short', 'HEAD'], signal)
    const name = branch.ok ? branch.stdout.trim() : ''
    if (!name) return { ok: false, error: '无法确定当前分支' }
    res = await runGit(root, ['push', '-u', 'origin', name], signal, NETWORK_TIMEOUT_MS)
  }
  if (res.ok) return { ok: true }
  
  const detail = res.stderr.trim() || res.stdout.trim()
  if (/non-fast-forward|fetch first|behind its remote/i.test(detail)) {
    return { ok: false, error: '远程有你本地没有的提交，推送被拒绝。请先点击「拉取」同步远程更改后再推送。' }
  }
  return { ok: false, error: detail || '推送失败' }
}

export async function pull(cwd: string, signal?: AbortSignal): Promise<GitOpResult> {
  const root = (await repoRoot(cwd, signal)) ?? cwd
  const res = await runGit(root, ['pull', '--rebase'], signal, NETWORK_TIMEOUT_MS)
  if (res.ok) return { ok: true }
  
  const stderr = res.stderr.trim()
  const stdout = res.stdout.trim()
  const conflicted = /conflict/i.test(stderr) || /conflict/i.test(stdout)
  if (conflicted) {
    return {
      ok: false,
      error: '拉取时存在冲突，已暂停 rebase。请在终端解决冲突后执行 `git rebase --continue`，或执行 `git rebase --abort` 取消。'
    }
  }
  return { ok: false, error: stderr || stdout || '拉取失败' }
}

/** Returns a diff suitable for feeding to an AI to generate a commit message. */
export async function getStagedDiffForAi(
  cwd: string,
  maxChars = 12_000,
  signal?: AbortSignal
): Promise<string> {
  const root = (await repoRoot(cwd, signal)) ?? cwd
  let res = await runGit(root, ['diff', '--cached', '--stat'], signal)
  const stat = res.ok ? res.stdout : ''
  res = await runGit(root, ['diff', '--cached'], signal)
  const diff = res.ok ? res.stdout : ''
  const combined = `${stat}\n\n${diff}`.trim()
  if (combined.length <= maxChars) return combined
  return combined.slice(0, maxChars) + '\n…(diff truncated)'
}
