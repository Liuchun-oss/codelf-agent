


function lastSepIndex(p: string): number {
  return Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
}

export function getSep(p: string): '\\' | '/' {
  return p.lastIndexOf('\\') >= p.lastIndexOf('/') ? '\\' : '/'
}

export function dirname(p: string): string {
  const i = lastSepIndex(p)
  if (i < 0) return p
  
  if (i === 0) return p.slice(0, 1)
  return p.slice(0, i)
}

export function basename(p: string): string {
  const i = lastSepIndex(p)
  return i < 0 ? p : p.slice(i + 1)
}


export function isInside(child: string, parent: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, '/')
  const c = norm(child)
  const p = norm(parent)
  if (c === p) return false
  return c.startsWith(p + '/')
}


export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/')
}

export function pathsEqual(a: string, b: string): boolean {
  const na = normalizePath(a)
  const nb = normalizePath(b)
  if (na === nb) return true
  
  if (na.toLowerCase() === nb.toLowerCase()) return true
  return false
}


export function toWorkspaceRelative(workspaceRoot: string | undefined, absPath: string): string {
  if (!workspaceRoot) return absPath
  const root = normalizePath(workspaceRoot).replace(/\/$/, '')
  const abs = normalizePath(absPath)
  if (abs === root) return basename(absPath)
  const prefix = root + '/'
  if (abs.startsWith(prefix)) return abs.slice(prefix.length)
  return absPath
}
