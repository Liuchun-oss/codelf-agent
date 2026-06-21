

function norm(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

let dirtyPaths = new Set<string>()

export function setEditorDirtyPaths(paths: string[]): void {
  dirtyPaths = new Set(paths.map(norm))
}

export function getEditorDirtyPaths(): string[] {
  return [...dirtyPaths]
}


export function isPathDirty(path: string, turnDirty: Set<string>): boolean {
  const n = norm(path)
  return turnDirty.has(n) || dirtyPaths.has(n)
}
