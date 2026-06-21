import { ipcMain } from 'electron'
import { setEditorDirtyPaths } from '../services/editorSnapshot'


export function registerEditorIpc(): void {
  ipcMain.handle('editor:updateDirtyPaths', async (_e, paths: unknown): Promise<boolean> => {
    if (!Array.isArray(paths)) return false
    setEditorDirtyPaths(paths.filter((p): p is string => typeof p === 'string'))
    return true
  })
}
