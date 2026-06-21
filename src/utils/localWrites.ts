

const recent = new Map<string, number>()
const DEFAULT_MS = 1500

export function noteLocalWrite(path: string): void {
  recent.set(path.replace(/\\/g, '/').toLowerCase(), Date.now())
}

export function wasRecentLocalWrite(path: string, withinMs = DEFAULT_MS): boolean {
  const key = path.replace(/\\/g, '/').toLowerCase()
  const at = recent.get(key)
  if (at == null) return false
  if (Date.now() - at > withinMs) {
    recent.delete(key)
    return false
  }
  return true
}
