import { resolve, isAbsolute, relative, join } from 'path'
import { homedir } from 'os'
import { DATA_DIR_NAME, ENV_SKILLS_DIR, ENV_USER_SKILLS_DIR } from '@shared/appConfig'

export function isPathWithinWorkspace(workspaceRoot: string | null | undefined, p: string): boolean {
  if (!workspaceRoot || !p.trim()) return false
  try {
    const abs = isAbsolute(p) ? resolve(p) : resolve(workspaceRoot, p)
    const rel = relative(workspaceRoot, abs)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  } catch {
    return false
  }
}


function isWithin(root: string, p: string): boolean {
  try {
    const rel = relative(resolve(root), resolve(p))
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  } catch {
    return false
  }
}


export function skillReadableRoots(): string[] {
  const roots: string[] = []
  const home = homedir()
  if (home) {
    roots.push(join(home, DATA_DIR_NAME, 'skills'))
    const env = process.env[ENV_SKILLS_DIR] || process.env[ENV_USER_SKILLS_DIR]
    if (env?.trim()) {
      for (const part of env.split(/[:;]/)) {
        if (part.trim()) roots.push(resolve(part.trim()))
      }
    }
  }
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resourcesPath) roots.push(join(resourcesPath, 'skills'))
  roots.push(join(__dirname, '..', '..', '..', 'resources', 'skills'))
  roots.push(resolve(process.cwd(), 'resources', 'skills'))
  return [...new Set(roots)]
}


export function isWithinSkillRoot(p: string): boolean {
  if (!p.trim()) return false
  try {
    const abs = isAbsolute(p) ? resolve(p) : resolve(p)
    return skillReadableRoots().some((root) => isWithin(root, abs))
  } catch {
    return false
  }
}


export function pathFromArgs(args: unknown): string | undefined {
  if (args && typeof args === 'object') {
    const p = (args as { path?: unknown }).path
    if (typeof p === 'string') return p
  }
  return undefined
}
