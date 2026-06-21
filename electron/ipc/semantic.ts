import { ipcMain, WebContents } from 'electron'
import {
  buildIndex,
  updateFiles,
  isBuilding,
  countIndexableFiles,
  AUTO_INDEX_FILE_LIMIT,
  type IndexProgress
} from '../services/semantic/indexer'
import { loadIndex, deleteIndex } from '../services/semantic/indexStore'

let lastProgress: IndexProgress | null = null
let currentBuild: AbortController | null = null

function broadcast(wc: WebContents | null, progress: IndexProgress): void {
  lastProgress = progress
  if (wc && !wc.isDestroyed()) wc.send('semantic:progress', progress)
}

export function registerSemanticIpc(): void {
  // 构建/重建索引（增量复用未变更文件）。
  ipcMain.handle('semantic:build', async (e, root: string): Promise<{ ok: boolean; error?: string }> => {
    if (!root) return { ok: false, error: '未指定工作区' }
    if (isBuilding()) return { ok: false, error: '索引正在构建中' }
    const wc = e.sender
    const controller = new AbortController()
    currentBuild = controller
    // 后台异步构建，进度通过事件推送，不阻塞调用方。
    void buildIndex(root, (p) => broadcast(wc, p), controller.signal)
      .catch((err) => {
        broadcast(wc, {
          phase: 'error',
          filesTotal: 0,
          filesProcessed: 0,
          chunksEmbedded: 0,
          error: err instanceof Error ? err.message : '索引构建失败'
        })
      })
      .finally(() => {
        if (currentBuild === controller) currentBuild = null
      })
    return { ok: true }
  })

  // 取消正在进行的构建。
  ipcMain.handle('semantic:cancel', async (): Promise<boolean> => {
    if (currentBuild) {
      currentBuild.abort()
      return true
    }
    return false
  })

  // 增量更新（文件保存后调用）。
  ipcMain.handle('semantic:update', async (_e, root: string, paths: string[]): Promise<boolean> => {
    if (!root || !Array.isArray(paths) || paths.length === 0) return false
    await updateFiles(root, paths).catch(() => {})
    return true
  })

  // 查询索引状态（是否已建、块数量、是否正在构建）。
  ipcMain.handle('semantic:status', async (_e, root: string) => {
    if (!root) return { indexed: false, building: false, fileCount: 0, chunkCount: 0 }
    const index = await loadIndex(root)
    const fileCount = Object.keys(index.files).length
    let chunkCount = 0
    for (const f of Object.values(index.files)) chunkCount += f.chunks.length
    return { indexed: fileCount > 0, building: isBuilding(), fileCount, chunkCount, lastProgress }
  })

  ipcMain.handle('semantic:clear', async (_e, root: string): Promise<boolean> => {
    if (!root) return false
    await deleteIndex(root)
    return true
  })

  // 估算文件规模 + 是否已有索引，供前端决定是否自动构建。
  ipcMain.handle('semantic:count', async (_e, root: string) => {
    if (!root) return { fileCount: 0, indexed: false, autoLimit: AUTO_INDEX_FILE_LIMIT }
    const index = await loadIndex(root)
    const indexed = Object.keys(index.files).length > 0
    const fileCount = await countIndexableFiles(root).catch(() => 0)
    return { fileCount, indexed, autoLimit: AUTO_INDEX_FILE_LIMIT }
  })
}
