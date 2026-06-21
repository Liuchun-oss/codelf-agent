import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { basename, join } from 'path'
import { APP_SLUG, DATA_DIR_NAME } from '@shared/appConfig'

export interface WorktreeSessionState {
  originalWorkspaceRoot: string
  worktreePath: string
  worktreeName: string
  branchName: string
  createdAt: number
}

const sessions = new Map<string, WorktreeSessionState>()
const VALID_WORKTREE_SLUG_SEGMENT = /^[a-zA-Z0-9._-]+$/
const MAX_WORKTREE_SLUG_LENGTH = 64

export function getWorktreeSession(sessionId: string): WorktreeSessionState | null {
  return sessions.get(sessionId) ?? null
}

export function clearWorktreeSession(sessionId: string): void {
  sessions.delete(sessionId)
}

export function validateWorktreeName(name: string): string | null {
  if (!name || name.length > MAX_WORKTREE_SLUG_LENGTH) {
    return `worktree name 必须为 1-${MAX_WORKTREE_SLUG_LENGTH} 个字符`
  }
  for (const segment of name.split('/')) {
    if (segment === '.' || segment === '..' || !VALID_WORKTREE_SLUG_SEGMENT.test(segment)) {
      return 'worktree name 只能包含字母、数字、点、下划线、短横线，可用 / 分段，但不能包含 . 或 .. 段'
    }
  }
  return null
}

function flattenName(name: string): string {
  return name.replaceAll('/', '+')
}

function branchNameFor(name: string): string {
  return `${APP_SLUG}-worktree-${flattenName(name)}`
}

function worktreePathFor(repoRoot: string, name: string): string {
  return join(repoRoot, DATA_DIR_NAME, 'worktrees', flattenName(name))
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' }
  }).trim()
}

function repoRootFor(workspaceRoot: string): string {
  return git(workspaceRoot, ['rev-parse', '--show-toplevel'])
}

export function enterWorktreeSession(input: {
  sessionId: string
  workspaceRoot: string | null
  name: string
  baseRef?: string
}): WorktreeSessionState | { error: string } {
  if (!input.workspaceRoot) return { error: 'EnterWorktree 需要已打开工作区。' }
  const validation = validateWorktreeName(input.name)
  if (validation) return { error: validation }

  let repoRoot: string
  try {
    repoRoot = repoRootFor(input.workspaceRoot)
  } catch {
    return { error: 'EnterWorktree 需要当前工作区是 Git 仓库。' }
  }

  const branchName = branchNameFor(input.name)
  const worktreePath = worktreePathFor(repoRoot, input.name)
  const worktreeParent = join(repoRoot, DATA_DIR_NAME, 'worktrees')
  mkdirSync(worktreeParent, { recursive: true })

  const baseRef = input.baseRef?.trim() || 'HEAD'
  try {
    if (!existsSync(worktreePath)) {
      git(repoRoot, ['worktree', 'add', '-b', branchName, worktreePath, baseRef])
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : '创建 git worktree 失败。' }
  }

  const state: WorktreeSessionState = {
    originalWorkspaceRoot: input.workspaceRoot,
    worktreePath,
    worktreeName: input.name,
    branchName,
    createdAt: Date.now()
  }
  sessions.set(input.sessionId, state)
  return state
}

export function exitWorktreeSession(input: {
  sessionId: string
  remove?: boolean
}): { originalWorkspaceRoot: string; removed: boolean; worktreePath?: string } | { error: string } {
  const state = sessions.get(input.sessionId)
  if (!state) return { error: '当前 session 不在 worktree 中。' }
  sessions.delete(input.sessionId)

  let removed = false
  if (input.remove) {
    try {
      git(state.originalWorkspaceRoot, ['worktree', 'remove', '--force', state.worktreePath])
      removed = true
    } catch {
      try {
        rmSync(state.worktreePath, { recursive: true, force: true })
        removed = true
      } catch {
        removed = false
      }
    }
  }

  return { originalWorkspaceRoot: state.originalWorkspaceRoot, removed, worktreePath: state.worktreePath }
}

export function describeWorktreeSession(sessionId: string): string {
  const state = sessions.get(sessionId)
  if (!state) return '未进入 worktree。'
  return [
    `worktree: ${state.worktreeName}`,
    `path: ${state.worktreePath}`,
    `branch: ${state.branchName}`,
    `original: ${state.originalWorkspaceRoot}`,
    `repo: ${basename(state.originalWorkspaceRoot)}`
  ].join('\n')
}
