import { ipcMain, dialog, BrowserWindow, clipboard, shell } from 'electron'
import { promises as fs } from 'fs'
import { join, basename, dirname, normalize, sep } from 'path'
import { execFile } from 'child_process'
import { fileURLToPath } from 'url'
import { type Ignore } from 'ignore'
import { suppressWatchPath } from './watcher'
import {
  IGNORED_DIRS,
  buildIgnore,
  toRel,
  readFileSafe,
  writeTextFile,
  listFiles,
  errMessage,
  type FileEncoding
} from '../services/fsService'

export interface FileTreeNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileTreeNode[]
}

export interface OpResult {
  ok: boolean
  error?: string
  path?: string
  newPath?: string
}

function isPathInside(child: string, parent: string): boolean {
  const c = normalize(child)
  const p = normalize(parent)
  if (c === p) return false
  return c.startsWith(p + sep)
}

function sortNodes(nodes: FileTreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-CN')
  })
}


async function buildTree(
  root: string,
  dir: string,
  expanded: Set<string>,
  ig: Ignore | null,
  depth = 0
): Promise<FileTreeNode[]> {
  if (depth > 40) return []
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const nodes: FileTreeNode[] = []

  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue
    const fullPath = join(dir, entry.name)
    const isDir = entry.isDirectory()
    if (ig) {
      const rel = toRel(root, fullPath) + (isDir ? '/' : '')
      if (rel && ig.ignores(rel)) continue
    }
    if (isDir) {
      const node: FileTreeNode = { name: entry.name, path: fullPath, type: 'directory' }
      if (expanded.has(fullPath)) {
        node.children = await buildTree(root, fullPath, expanded, ig, depth + 1)
      }
      nodes.push(node)
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      nodes.push({ name: entry.name, path: fullPath, type: 'file' })
    }
  }

  sortNodes(nodes)
  return nodes
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

export function registerFileIpc(): void {
  ipcMain.handle(
    'fs:tree',
    async (_e, rootPath: string, expanded: string[] = [], showIgnored = false): Promise<FileTreeNode[]> => {
      const ig = showIgnored ? null : await buildIgnore(rootPath)
      return buildTree(rootPath, rootPath, new Set(expanded), ig)
    }
  )

  ipcMain.handle('fs:listFiles', async (_e, rootPath: string): Promise<string[]> =>
    listFiles(rootPath)
  )

  ipcMain.handle('fs:readFile', async (_e, filePath: string) => fs.readFile(filePath, 'utf-8'))

  ipcMain.handle('fs:readFileSafe', async (_e, filePath: string) => readFileSafe(filePath))

  ipcMain.handle('fs:exists', async (_e, filePath: string): Promise<boolean> => {
    if (typeof filePath !== 'string' || !filePath) return false
    try {
      await fs.access(filePath)
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('fs:rootFileNames', async (_e, dirPath: string): Promise<string[]> => {
    if (typeof dirPath !== 'string' || !dirPath) return []
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true })
      return entries.filter((e) => e.isFile()).map((e) => e.name)
    } catch {
      return []
    }
  })

  ipcMain.handle(
    'fs:writeFile',
    async (_e, filePath: string, content: string, encoding: FileEncoding = 'utf8') => {
      await writeTextFile(filePath, content, encoding)
      suppressWatchPath(filePath)
      return true
    }
  )

  ipcMain.handle('fs:createFile', async (_e, parentPath: string, name: string): Promise<OpResult> => {
    const target = join(parentPath, name)
    try {
      
      const handle = await fs.open(target, 'wx')
      await handle.close()
      return { ok: true, path: target }
    } catch (e) {
      return { ok: false, error: errMessage(e) }
    }
  })

  ipcMain.handle('fs:createFolder', async (_e, parentPath: string, name: string): Promise<OpResult> => {
    const target = join(parentPath, name)
    try {
      await fs.mkdir(target)
      return { ok: true, path: target }
    } catch (e) {
      return { ok: false, error: errMessage(e) }
    }
  })

  ipcMain.handle('fs:delete', async (_e, targetPath: string): Promise<OpResult> => {
    try {
      await fs.rm(targetPath, { recursive: true, force: false })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: errMessage(e) }
    }
  })

  ipcMain.handle('fs:rename', async (_e, oldPath: string, newName: string): Promise<OpResult> => {
    const newPath = join(dirname(oldPath), newName)
    if (newPath === oldPath) return { ok: true, newPath }
    try {
      
      if (newPath.toLowerCase() !== oldPath.toLowerCase() && (await exists(newPath))) {
        return { ok: false, error: '同名文件或文件夹已存在' }
      }
      await fs.rename(oldPath, newPath)
      return { ok: true, newPath }
    } catch (e) {
      return { ok: false, error: errMessage(e) }
    }
  })

  ipcMain.handle(
    'dialog:saveFile',
    async (_e, suggestedName: string, content: string): Promise<OpResult> => {
      const win = BrowserWindow.getFocusedWindow()
      const opts = { defaultPath: suggestedName }
      const result = win
        ? await dialog.showSaveDialog(win, opts)
        : await dialog.showSaveDialog(opts)
      if (result.canceled || !result.filePath) return { ok: false }
      try {
        await writeTextFile(result.filePath, content, 'utf8')
        suppressWatchPath(result.filePath)
        return { ok: true, path: result.filePath }
      } catch (e) {
        return { ok: false, error: errMessage(e) }
      }
    }
  )

  ipcMain.handle('dialog:openFolder', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    const folder = result.filePaths[0]
    return { path: folder, name: basename(folder) }
  })

  ipcMain.handle('clipboard:writeText', async (_e, text: string) => {
    clipboard.writeText(text)
    return true
  })

  ipcMain.handle('clipboard:readText', async () => clipboard.readText())

  ipcMain.handle('clipboard:readFiles', async (): Promise<string[]> => readClipboardFiles())

  
  ipcMain.handle('fs:move', async (_e, src: string, destDir: string): Promise<OpResult> => {
    const target = join(destDir, basename(src))
    if (target === src) return { ok: true, newPath: src }
    if (dirname(src) === target || src === destDir) return { ok: false, error: '不能移动到自身' }
    if (destDir === src || isPathInside(destDir, src)) {
      return { ok: false, error: '不能移动到自身的子目录' }
    }
    try {
      if (await exists(target)) return { ok: false, error: '目标位置已存在同名项' }
      try {
        await fs.rename(src, target)
      } catch (e) {
        if (e && typeof e === 'object' && (e as { code?: string }).code === 'EXDEV') {
          await fs.cp(src, target, { recursive: true, errorOnExist: true, force: false })
          await fs.rm(src, { recursive: true, force: true })
        } else {
          throw e
        }
      }
      return { ok: true, newPath: target }
    } catch (e) {
      return { ok: false, error: errMessage(e) }
    }
  })

  
  ipcMain.handle('fs:copy', async (_e, src: string, destDir: string): Promise<OpResult> => {
    let target = join(destDir, basename(src))
    try {
      if (await exists(target)) {
        const name = basename(src)
        const dot = name.lastIndexOf('.')
        const base = dot > 0 ? name.slice(0, dot) : name
        const ext = dot > 0 ? name.slice(dot) : ''
        let i = 1
        do {
          target = join(destDir, `${base} 副本${i > 1 ? ` ${i}` : ''}${ext}`)
          i++
        } while (await exists(target))
      }
      await fs.cp(src, target, { recursive: true, errorOnExist: true, force: false })
      return { ok: true, newPath: target }
    } catch (e) {
      return { ok: false, error: errMessage(e) }
    }
  })

  ipcMain.handle('fs:reveal', async (_e, targetPath: string) => {
    shell.showItemInFolder(targetPath)
    return true
  })

  ipcMain.handle('fs:openExternal', async (_e, target: string) => {
    
    if (/^https?:\/\//i.test(target)) {
      await shell.openExternal(target)
      return true
    }
    const err = await shell.openPath(target)
    return err === ''
  })
}

function execFileAsync(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      resolve(err ? '' : stdout)
    })
  })
}

async function readClipboardFiles(): Promise<string[]> {
  if (process.platform === 'win32') {
    
    const out = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }'
    ])
    return out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
  }
  
  const uriList = clipboard.read('text/uri-list')
  if (uriList) {
    return uriList
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith('file://'))
      .map((u) => {
        try {
          return fileURLToPath(u)
        } catch {
          return ''
        }
      })
      .filter((p) => p.length > 0)
  }
  return []
}
