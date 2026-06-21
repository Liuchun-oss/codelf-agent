import { runCommand } from '../../services/headlessTerminal'



export interface GitContextSnapshot {
  isRepo: boolean
  branch?: string
  short?: string
  
  recentCommits?: string
}


const RECENT_COMMITS_BUDGET = 800

export async function collectGitContext(
  workspaceRoot: string | null | undefined,
  signal?: AbortSignal
): Promise<GitContextSnapshot> {
  if (!workspaceRoot) return { isRepo: false }
  if (!(await isGitRepo(workspaceRoot, signal))) return { isRepo: false }

  const [branch, short, recentCommits] = await Promise.all([
    runGit(workspaceRoot, ['symbolic-ref', '--short', 'HEAD'], signal),
    runGit(workspaceRoot, ['rev-parse', '--short', 'HEAD'], signal),
    runGit(workspaceRoot, ['log', '-n', '5', '--pretty=format:%h %s'], signal)
  ])

  return {
    isRepo: true,
    branch: branch.ok ? branch.stdout.trim() || undefined : undefined,
    short: short.ok ? short.stdout.trim() || undefined : undefined,
    recentCommits: recentCommits.ok
      ? truncate(recentCommits.stdout.trim(), RECENT_COMMITS_BUDGET)
      : undefined
  }
}


export function renderGitContext(snap: GitContextSnapshot): string | null {
  if (!snap.isRepo) return null
  const lines: string[] = []
  if (snap.branch) lines.push(`Branch: ${snap.branch}${snap.short ? ` (${snap.short})` : ''}`)
  else if (snap.short) lines.push(`Branch: (detached at ${snap.short})`)
  if (snap.recentCommits) {
    lines.push('')
    lines.push('Recent commits:')
    lines.push(snap.recentCommits)
  }
  if (lines.length === 0) return null
  return ['# Git context', '', ...lines].join('\n')
}

async function isGitRepo(cwd: string, signal?: AbortSignal): Promise<boolean> {
  const res = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'], signal)
  return res.ok && /^true\s*$/i.test(res.stdout.trim())
}

interface GitResult {
  ok: boolean
  stdout: string
}

async function runGit(cwd: string, args: string[], signal?: AbortSignal): Promise<GitResult> {
  try {
    const res = await runCommand(`git ${args.map(shellQuote).join(' ')}`, {
      cwd,
      timeoutMs: 4_000,
      signal
    })
    return { ok: res.exitCode === 0, stdout: res.stdout }
  } catch {
    return { ok: false, stdout: '' }
  }
}

function shellQuote(arg: string): string {
  if (/^[\w./=:-]+$/.test(arg)) return arg
  
  return `"${arg.replace(/"/g, '\\"')}"`
}


function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + `\n…(truncated, ${text.length - max} more chars)`
}
