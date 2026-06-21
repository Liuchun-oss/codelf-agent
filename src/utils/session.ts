import type { Workspace } from '@/types'
import { appStorageKey } from '@shared/appConfig'



export interface SessionData {
  openPaths: string[]
  activePath: string | null
  expanded: string[]
}

const SESSION_PREFIX = appStorageKey('session:')
const RECENT_KEY = appStorageKey('recent')
const MAX_RECENT = 10


export function isPersistableTabPath(path: string): boolean {
  return (
    !path.startsWith('untitled:') &&
    !path.startsWith('diff:') &&
    !path.startsWith('gitdiff:')
  )
}

export function loadSession(workspacePath: string): SessionData | null {
  try {
    const raw = localStorage.getItem(SESSION_PREFIX + workspacePath)
    if (!raw) return null
    const data = JSON.parse(raw) as Partial<SessionData>
    const rawPaths = Array.isArray(data.openPaths)
      ? data.openPaths.filter((p): p is string => typeof p === 'string')
      : []
    return {
      openPaths: [...new Set(rawPaths.filter(isPersistableTabPath))],
      activePath:
        typeof data.activePath === 'string' && isPersistableTabPath(data.activePath)
          ? data.activePath
          : null,
      expanded: Array.isArray(data.expanded) ? data.expanded : []
    }
  } catch {
    return null
  }
}

export function saveSession(workspacePath: string, data: SessionData): void {
  try {
    localStorage.setItem(SESSION_PREFIX + workspacePath, JSON.stringify(data))
  } catch {
    
  }
}

export function getRecentWorkspaces(): Workspace[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw) as Workspace[]
    return Array.isArray(arr) ? arr.filter((w) => w && w.path && w.name) : []
  } catch {
    return []
  }
}

export function addRecentWorkspace(ws: Workspace): void {
  try {
    const list = getRecentWorkspaces().filter((w) => w.path !== ws.path)
    list.unshift(ws)
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT)))
  } catch {
    
  }
}
