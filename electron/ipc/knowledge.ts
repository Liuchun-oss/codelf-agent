import { ipcMain, dialog, BrowserWindow, WebContents } from 'electron'
import { randomUUID } from 'crypto'
import {
  importDocuments,
  isImporting,
  ensureKb,
  SUPPORTED_EXT_LIST,
  rebuildKnowledge,
  previewImport,
  type ImportProgress,
  type ImportResult
} from '../services/knowledge/indexer'
import { searchKnowledge } from '../services/knowledge/retriever'
import {
  listKbs,
  deleteKb,
  listDocs,
  deleteDoc,
  kbStats,
  probeStore,
  healthCheck,
  repairKb,
  exportKb,
  findOutdatedDocs
} from '../services/knowledge/store'

let lastProgress: ImportProgress | null = null
let lastResult: ImportResult | null = null
let currentImport: AbortController | null = null

function broadcast(wc: WebContents | null, progress: ImportProgress): void {
  lastProgress = progress
  if (wc && !wc.isDestroyed()) wc.send('knowledge:progress', progress)
}

export function registerKnowledgeIpc(): void {
  // 存储可用性探测（原生模块是否就绪）。
  ipcMain.handle('knowledge:probe', async () => probeStore())

  // 列出所有知识库及其统计。
  ipcMain.handle('knowledge:listKbs', async () => {
    const probe = probeStore()
    if (!probe.ok) return { ok: false, error: probe.error, kbs: [] }
    const kbs = listKbs().map((kb) => ({ ...kb, ...kbStats(kb.id) }))
    return { ok: true, kbs }
  })

  // 新建知识库。
  ipcMain.handle('knowledge:createKb', async (_e, name: string) => {
    const probe = probeStore()
    if (!probe.ok) return { ok: false, error: probe.error }
    const trimmed = (name || '').trim()
    if (!trimmed) return { ok: false, error: '知识库名称不能为空' }
    const id = randomUUID()
    ensureKb(id, trimmed)
    return { ok: true, id }
  })

  // 删除知识库（连同文档与向量）。
  ipcMain.handle('knowledge:deleteKb', async (_e, kbId: string) => {
    if (!kbId) return { ok: false, error: '未指定知识库' }
    deleteKb(kbId)
    return { ok: true }
  })

  // 列出某知识库的文档。
  ipcMain.handle('knowledge:listDocs', async (_e, kbId: string) => {
    if (!kbId) return { ok: false, error: '未指定知识库', docs: [] }
    return { ok: true, docs: listDocs(kbId) }
  })

  // 移除单个文档。
  ipcMain.handle('knowledge:removeDoc', async (_e, docId: string) => {
    if (!docId) return { ok: false, error: '未指定文档' }
    deleteDoc(docId)
    return { ok: true }
  })

  // 选择要导入的文档（多选）。
  ipcMain.handle('knowledge:pickDocs', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const opts = {
      properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
      filters: [
        { name: '文档', extensions: SUPPORTED_EXT_LIST.map((e) => e.replace(/^\./, '')) }
      ]
    }
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths
  })

  // 选择要导入的文件夹（递归收集受支持文档）。
  ipcMain.handle('knowledge:pickFolder', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const opts = { properties: ['openDirectory'] as Array<'openDirectory'> }
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // 导入文档（后台异步，进度走事件）。
  ipcMain.handle('knowledge:import', async (e, kbId: string, paths: string[]) => {
    const probe = probeStore()
    if (!probe.ok) return { ok: false, error: probe.error }
    if (!kbId) return { ok: false, error: '未指定知识库' }
    if (!Array.isArray(paths) || paths.length === 0) return { ok: false, error: '未选择文档' }
    if (isImporting()) return { ok: false, error: '已有导入任务进行中' }
    const wc = e.sender
    const controller = new AbortController()
    currentImport = controller
    lastResult = null
    void importDocuments(kbId, paths, (p) => broadcast(wc, p), controller.signal)
      .then((result) => {
        lastResult = result
      })
      .catch((err) => {
        broadcast(wc, {
          phase: 'error',
          filesTotal: 0,
          filesProcessed: 0,
          chunksEmbedded: 0,
          error: err instanceof Error ? err.message : '导入失败'
        })
      })
      .finally(() => {
        if (currentImport === controller) currentImport = null
      })
    return { ok: true }
  })

  // 预览导入：扫描文件状态但不实际导入。
  ipcMain.handle('knowledge:preview', async (_e, kbId: string, paths: string[]) => {
    const probe = probeStore()
    if (!probe.ok) return { ok: false, error: probe.error, files: [] }
    if (!kbId) return { ok: false, error: '未指定知识库', files: [] }
    if (!Array.isArray(paths) || paths.length === 0) return { ok: false, error: '未选择文档', files: [] }
    try {
      const files = await previewImport(kbId, paths)
      return { ok: true, files }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : '预览失败', files: [] }
    }
  })

  ipcMain.handle('knowledge:cancel', async () => {
    if (currentImport) {
      currentImport.abort()
      return true
    }
    return false
  })

  ipcMain.handle('knowledge:status', async () => ({
    importing: isImporting(),
    lastProgress,
    lastResult
  }))

  // 重建知识库：清空向量，重新解析和向量化所有文档。
  ipcMain.handle('knowledge:rebuild', async (e, kbId: string) => {
    const probe = probeStore()
    if (!probe.ok) return { ok: false, error: probe.error }
    if (!kbId) return { ok: false, error: '未指定知识库' }
    if (isImporting()) return { ok: false, error: '已有导入或重建任务进行中' }
    const wc = e.sender
    const controller = new AbortController()
    currentImport = controller
    lastResult = null
    void rebuildKnowledge(kbId, (p) => broadcast(wc, p), controller.signal)
      .then((result) => {
        lastResult = result
      })
      .catch((err) => {
        broadcast(wc, {
          phase: 'error',
          filesTotal: 0,
          filesProcessed: 0,
          chunksEmbedded: 0,
          error: err instanceof Error ? err.message : '重建失败'
        })
      })
      .finally(() => {
        if (currentImport === controller) currentImport = null
      })
    return { ok: true }
  })

  // 检索（供 UI 测试用；Agent 走工具）。
  ipcMain.handle('knowledge:query', async (_e, kbId: string, query: string, topK?: number) => {
    if (!query) return { ok: false, hits: [], error: '查询为空' }
    return searchKnowledge(kbId, query, { topK: topK ?? 8 })
  })

  // 健康检查：检测知识库的完整性与一致性问题。
  ipcMain.handle('knowledge:healthCheck', async (_e, kbId: string) => {
    const probe = probeStore()
    if (!probe.ok) return { ok: false, error: probe.error, issues: [], stats: {} }
    if (!kbId) return { ok: false, error: '未指定知识库', issues: [], stats: {} }
    try {
      return healthCheck(kbId)
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : '检查失败', issues: [], stats: {} }
    }
  })

  // 修复知识库：清理孤儿数据、修正计数。
  ipcMain.handle('knowledge:repair', async (_e, kbId: string) => {
    const probe = probeStore()
    if (!probe.ok) return { ok: false, error: probe.error }
    if (!kbId) return { ok: false, error: '未指定知识库' }
    try {
      const result = repairKb(kbId)
      return { ok: true, fixed: result.fixed }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : '修复失败' }
    }
  })

  // 导出知识库：保存元数据到 JSON 文件（不含向量，便于备份）。
  ipcMain.handle('knowledge:export', async (_e, kbId: string) => {
    const probe = probeStore()
    if (!probe.ok) return { ok: false, error: probe.error }
    if (!kbId) return { ok: false, error: '未指定知识库' }
    try {
      const data = exportKb(kbId)
      if (!data) return { ok: false, error: '知识库不存在' }
      const win = BrowserWindow.getFocusedWindow()
      const saveOpts = {
        title: '导出知识库',
        defaultPath: `${data.kb.name.replace(/[^\w一-龥]/g, '_')}_export.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }]
      }
      const result = win ? await dialog.showSaveDialog(win, saveOpts) : await dialog.showSaveDialog(saveOpts)
      if (result.canceled || !result.filePath) return { ok: false, error: '已取消' }
      const fs = await import('fs/promises')
      await fs.writeFile(result.filePath, JSON.stringify(data, null, 2), 'utf8')
      return { ok: true, path: result.filePath }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : '导出失败' }
    }
  })

  // 检测过期文档：文件已变更或删除。
  ipcMain.handle('knowledge:findOutdated', async (_e, kbId: string) => {
    const probe = probeStore()
    if (!probe.ok) return { ok: false, error: probe.error, outdated: [] }
    if (!kbId) return { ok: false, error: '未指定知识库', outdated: [] }
    try {
      const outdated = await findOutdatedDocs(kbId)
      return { ok: true, outdated }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : '检测失败', outdated: [] }
    }
  })

  // 从导出的 JSON 文件导入知识库
  ipcMain.handle('knowledge:importFromExport', async (_e, kbId: string) => {
    const probe = probeStore()
    if (!probe.ok) return { ok: false, error: probe.error }
    if (!kbId) return { ok: false, error: '未指定知识库' }
    try {
      const win = BrowserWindow.getFocusedWindow()
      const openOpts = {
        title: '选择导出的知识库 JSON 文件',
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile' as const]
      }
      const result = win ? await dialog.showOpenDialog(win, openOpts) : await dialog.showOpenDialog(openOpts)
      if (result.canceled || !result.filePaths[0]) return { ok: false, error: '已取消' }

      const fs = await import('fs/promises')
      const content = await fs.readFile(result.filePaths[0], 'utf8')
      const exported = JSON.parse(content)

      if (!exported.docs || !Array.isArray(exported.docs)) {
        return { ok: false, error: 'JSON 格式错误：缺少 docs 数组' }
      }

      // 提取所有文档路径
      const paths = exported.docs.map((doc: any) => doc.path).filter(Boolean)
      if (paths.length === 0) {
        return { ok: false, error: 'JSON 中没有找到文档路径' }
      }

      // 检查文件是否存在
      const existing: string[] = []
      const missing: string[] = []
      for (const path of paths) {
        try {
          await fs.access(path)
          existing.push(path)
        } catch {
          missing.push(path)
        }
      }

      return { ok: true, existing, missing, totalDocs: paths.length }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : '读取失败' }
    }
  })
}
