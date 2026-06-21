import { ipcMain, WebContents } from 'electron'
import { watch, FSWatcher } from 'fs'
import { join } from 'path'




let watcher: FSWatcher | null = null
let wc: WebContents | null = null
let timer: ReturnType<typeof setTimeout> | null = null
const pending = new Set<string>()

const suppressedUntil = new Map<string, number>()
const SUPPRESS_MS = 1500


const IGNORED_SEG = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'release',
  'build',
  'target',
  '.next',
  '.turbo',
  '.vite',
  '__pycache__',
  '.venv',
  'venv'
])

function normalizeKey(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

export function suppressWatchPath(filePath: string): void {
  suppressedUntil.set(normalizeKey(filePath), Date.now() + SUPPRESS_MS)
}

function isSuppressed(absPath: string): boolean {
  const key = normalizeKey(absPath)
  const until = suppressedUntil.get(key)
  if (until == null) return false
  if (Date.now() > until) {
    suppressedUntil.delete(key)
    return false
  }
  return true
}

function isIgnored(rel: string): boolean {
  return rel.split(/[\\/]/).some((p) => IGNORED_SEG.has(p))
}

function queuePath(absPath: string): void {
  if (isSuppressed(absPath)) return
  pending.add(absPath)
  if (timer) clearTimeout(timer)
  timer = setTimeout(flush, 250)
}

function flush(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (!wc || wc.isDestroyed() || pending.size === 0) {
    pending.clear()
    return
  }
  const paths = [...pending]
  pending.clear()
  wc.send('fs:event', { paths })
}

function stop(): void {
  if (watcher) {
    try {
      watcher.close()
    } catch {
      
    }
    watcher = null
  }
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  pending.clear()
}

export function stopWatcher(): void {
  stop()
  wc = null
}

export function registerWatcherIpc(): void {
  ipcMain.handle('fs:watch', (e, root: string): boolean => {
    stop()
    if (!root) return false
    wc = e.sender
    try {
      
      watcher = watch(root, { recursive: true }, (_event, filename) => {
        if (!filename) return
        const rel = filename.toString()
        if (isIgnored(rel)) return
        queuePath(join(root, rel))
      })
      watcher.on('error', () => stop())
      return true
    } catch {
      try {
        watcher = watch(root, (_event, filename) => {
          if (!filename) return
          queuePath(join(root, filename.toString()))
        })
        return true
      } catch {
        return false
      }
    }
  })

  ipcMain.handle('fs:unwatch', (): boolean => {
    stop()
    return true
  })
}
