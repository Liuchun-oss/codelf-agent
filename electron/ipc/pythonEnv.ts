import { ipcMain, app, dialog, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { discoverPythonEnvs, probeVersion } from '../services/pythonEnvService'
import type {
  PythonDiscoverResult,
  PythonSelectionResult,
  PythonEnv
} from '@shared/pythonTypes'

interface PersistShape {
  
  selections: Record<string, string>
}

let cache: PersistShape | null = null

function stateFile(): string {
  return join(app.getPath('userData'), 'pythonEnv.json')
}

function load(): PersistShape {
  if (cache) return cache
  const file = stateFile()
  if (!existsSync(file)) {
    cache = { selections: {} }
    return cache
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<PersistShape>
    cache = { selections: parsed?.selections && typeof parsed.selections === 'object' ? parsed.selections : {} }
  } catch {
    cache = { selections: {} }
  }
  return cache
}

function save(): void {
  if (!cache) return
  try {
    writeFileSync(stateFile(), JSON.stringify(cache, null, 2), 'utf8')
  } catch {
    
  }
}

function keyFor(workspaceRoot: string | null | undefined): string {
  return workspaceRoot && workspaceRoot.trim() ? workspaceRoot : '__global__'
}

export function registerPythonIpc(): void {
  ipcMain.handle(
    'python:discover',
    async (_e, workspaceRoot?: string): Promise<PythonDiscoverResult> => {
      try {
        const envs = await discoverPythonEnvs(workspaceRoot)
        return { ok: true, envs }
      } catch (err) {
        return { ok: false, envs: [], error: err instanceof Error ? err.message : '发现失败' }
      }
    }
  )

  ipcMain.handle(
    'python:getSelected',
    async (_e, workspaceRoot?: string): Promise<PythonSelectionResult> => {
      const exe = load().selections[keyFor(workspaceRoot)]
      if (!exe) return { ok: true, env: null }
      if (!existsSync(exe)) return { ok: true, env: null }
      const version = await probeVersion(exe)
      const env: PythonEnv = {
        id: process.platform === 'win32' ? exe.toLowerCase() : exe,
        executable: exe,
        version,
        kind: 'unknown',
        label: version ? `Python ${version}` : exe,
        detail: exe
      }
      return { ok: true, env }
    }
  )

  ipcMain.handle(
    'python:setSelected',
    async (_e, workspaceRoot: string | undefined, executable: string): Promise<PythonSelectionResult> => {
      if (!executable || !existsSync(executable)) {
        return { ok: false, error: '解释器路径无效' }
      }
      const state = load()
      state.selections[keyFor(workspaceRoot)] = executable
      save()
      const version = await probeVersion(executable)
      const env: PythonEnv = {
        id: process.platform === 'win32' ? executable.toLowerCase() : executable,
        executable,
        version,
        kind: 'unknown',
        label: version ? `Python ${version}` : executable,
        detail: executable
      }
      return { ok: true, env }
    }
  )

  ipcMain.handle('python:browse', async (): Promise<PythonSelectionResult> => {
    const win = BrowserWindow.getFocusedWindow()
    const isWin = process.platform === 'win32'
    const filters = isWin
      ? [
          { name: 'Python 解释器', extensions: ['exe'] },
          { name: '所有文件', extensions: ['*'] }
        ]
      : [{ name: '所有文件', extensions: ['*'] }]
    const opts: Electron.OpenDialogOptions = {
      title: '选择 Python 解释器',
      properties: ['openFile'],
      filters
    }
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts)
    if (result.canceled || result.filePaths.length === 0) return { ok: true, env: null }

    const exe = result.filePaths[0]
    const version = await probeVersion(exe)
    if (!version) {
      return { ok: false, error: '所选文件不是有效的 Python 解释器' }
    }
    const env: PythonEnv = {
      id: isWin ? exe.toLowerCase() : exe,
      executable: exe,
      version,
      kind: 'unknown',
      label: `Python ${version}`,
      detail: exe
    }
    return { ok: true, env }
  })
}
