import { promises as fs } from 'fs'
import { join, extname, basename } from 'path'
import { createHash, randomUUID } from 'crypto'
import { parseDocument, isSupportedDoc, SUPPORTED_EXTS } from './parsers'
import { chunkDocument } from './chunker'
import { embedTexts } from './embedService'
import {
  createKb,
  getKb,
  getDocByPath,
  deleteDoc,
  insertDoc,
  clearKbVectors,
  listDocs,
  type ChunkInsert
} from './store'

const MAX_DOC_BYTES = 20 * 1024 * 1024
const CONCURRENT_IMPORT = 3 // 并发导入文档数（解析+向量化可并行）

// SQLite 写入队列：确保数据库写操作串行执行，避免并发写冲突。
class SimpleQueue {
  private queue: Array<() => Promise<void>> = []
  private running = false

  async add<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await fn()
          resolve(result)
        } catch (e) {
          reject(e)
        }
      })
      void this.process()
    })
  }

  private async process(): Promise<void> {
    if (this.running || this.queue.length === 0) return
    this.running = true
    while (this.queue.length > 0) {
      const task = this.queue.shift()
      if (task) await task()
    }
    this.running = false
  }
}

const dbWriteQueue = new SimpleQueue()

export interface ImportProgress {
  phase: 'scanning' | 'parsing' | 'embedding' | 'done' | 'error'
  filesTotal: number
  filesProcessed: number
  chunksEmbedded: number
  currentFile?: string
  error?: string
  warnings?: Array<{ path: string; message: string }>
}

export interface ImportResult {
  imported: number
  skipped: number
  failed: number
  failedFiles?: Array<{ path: string; reason: string }>
  warnings?: Array<{ path: string; message: string }>
}

type ProgressCb = (p: ImportProgress) => void

export interface PreviewFile {
  path: string
  size: number
  status: 'new' | 'unchanged' | 'updated' | 'oversized' | 'empty' | 'unsupported'
  reason?: string
}

// 扫描待导入文件，返回每个文件的预览状态（不实际导入）。
export async function previewImport(kbId: string, inputPaths: string[]): Promise<PreviewFile[]> {
  const files = await collectDocs(inputPaths)
  const previews: PreviewFile[] = []

  for (const path of files) {
    try {
      const stat = await fs.stat(path)
      const size = stat.size

      if (size === 0) {
        previews.push({ path, size, status: 'empty', reason: '文件为空' })
        continue
      }
      if (size > MAX_DOC_BYTES) {
        previews.push({ path, size, status: 'oversized', reason: `超过 20MB 限制` })
        continue
      }

      const ext = extname(path).toLowerCase()
      if (!SUPPORTED_EXT_LIST.includes(ext)) {
        previews.push({ path, size, status: 'unsupported', reason: '不支持的格式' })
        continue
      }

      // 检查是否已存在、hash 是否变化
      const prev = getDocByPath(kbId, path)
      if (!prev) {
        previews.push({ path, size, status: 'new' })
        continue
      }

      // 修复：二进制文件用 Buffer 计算 hash
      const content = await fs.readFile(path)
      const hash = hashContent(content)
      if (hash === prev.hash) {
        previews.push({ path, size, status: 'unchanged' })
      } else {
        previews.push({ path, size, status: 'updated' })
      }
    } catch (e) {
      previews.push({ path, size: 0, status: 'unsupported', reason: e instanceof Error ? e.message : '无法读取' })
    }
  }

  return previews
}

function hashContent(content: Buffer | string): string {
  return createHash('sha1').update(content).digest('hex')
}

// 递归收集目录下受支持的文档（或直接接受文件列表）。
async function collectDocs(paths: string[]): Promise<string[]> {
  const out: string[] = []
  async function walk(p: string, depth: number): Promise<void> {
    if (depth > 20) return
    let stat
    try {
      stat = await fs.stat(p)
    } catch {
      return
    }
    if (stat.isDirectory()) {
      if (basename(p).startsWith('.')) return
      let entries: string[]
      try {
        entries = await fs.readdir(p)
      } catch {
        return
      }
      for (const name of entries) await walk(join(p, name), depth + 1)
    } else if (stat.isFile() && isSupportedDoc(p)) {
      out.push(p)
    }
  }
  for (const p of paths) await walk(p, 0)
  return [...new Set(out)]
}

let importing = false

export function isImporting(): boolean {
  return importing
}

export const SUPPORTED_EXT_LIST = [...SUPPORTED_EXTS]

// 确保知识库存在，不存在则创建。返回 kbId。
export function ensureKb(kbId: string, name: string): void {
  if (!getKb(kbId)) createKb(kbId, name)
}

// 导入一批文档（文件或目录）到指定知识库；增量：hash 未变的文档跳过。
// 支持并发处理：多文件同时解析和向量化，提升大批量导入速度。
export async function importDocuments(
  kbId: string,
  inputPaths: string[],
  onProgress?: ProgressCb,
  signal?: AbortSignal
): Promise<ImportResult> {
  if (importing) throw new Error('知识库正在导入中')
  importing = true
  let imported = 0
  let skipped = 0
  let failed = 0
  let embedded = 0
  const failedFiles: Array<{ path: string; reason: string }> = []
  const warnings: Array<{ path: string; message: string }> = []
  try {
    const files = await collectDocs(inputPaths)
    onProgress?.({ phase: 'scanning', filesTotal: files.length, filesProcessed: 0, chunksEmbedded: 0 })

    let processed = 0
    let lastEmit = 0
    const emit = (phase: ImportProgress['phase'], currentFile?: string): void => {
      const now = Date.now()
      if (phase === 'done' || phase === 'error' || now - lastEmit >= 150) {
        lastEmit = now
        onProgress?.({
          phase,
          filesTotal: files.length,
          filesProcessed: processed,
          chunksEmbedded: embedded,
          currentFile,
          warnings: warnings.length > 0 ? warnings : undefined
        })
      }
    }

    // 并发处理：每批最多 CONCURRENT_IMPORT 个文件同时处理
    for (let i = 0; i < files.length; i += CONCURRENT_IMPORT) {
      if (signal?.aborted) throw new Error('导入已取消')
      const batch = files.slice(i, i + CONCURRENT_IMPORT)

      await Promise.all(
        batch.map(async (path) => {
          processed++
          try {
            const stat = await fs.stat(path)
            if (stat.size === 0) {
              skipped++
              failedFiles.push({ path, reason: '文件为空' })
              emit('parsing', path)
              return
            }
            if (stat.size > MAX_DOC_BYTES) {
              skipped++
              failedFiles.push({ path, reason: `文件过大 (${Math.round(stat.size / 1024 / 1024)}MB > 20MB)` })
              emit('parsing', path)
              return
            }

            emit('parsing', path)
            const parsed = await parseDocument(path)

            // 收集警告信息（如 .doc 格式提示）
            if (parsed.warning) {
              warnings.push({ path, message: parsed.warning })
            }

            // 修复：二进制文件用 Buffer 计算 hash
            const content = await fs.readFile(path)
            const hash = hashContent(content)

            const prev = getDocByPath(kbId, path)
            if (prev && prev.hash === hash) {
              skipped++
              emit('parsing', path)
              return
            }

            const chunks = chunkDocument(parsed.text)
            if (chunks.length === 0) {
              skipped++
              failedFiles.push({ path, reason: '解析后无有效内容' })
              emit('parsing', path)
              return
            }

            emit('embedding', path)
            const vectors = await embedTexts(chunks.map((c) => c.text))
            const rows: ChunkInsert[] = chunks.map((c, i) => ({
              text: c.text,
              heading: c.heading,
              ordinal: c.ordinal,
              vector: vectors[i]
            }))

            // 写入数据库需要串行（避免 SQLite 并发写冲突）
            // 重导入：先删旧文档，再写新版本。
            await dbWriteQueue.add(async () => {
              if (prev) deleteDoc(prev.id)
              insertDoc(
                {
                  id: randomUUID(),
                  kbId,
                  path,
                  title: parsed.title || basename(path, extname(path)),
                  hash
                },
                rows
              )
            })
            embedded += rows.length
            imported++
            emit('embedding', path)
          } catch (e) {
            failed++
            const reason = e instanceof Error ? e.message : '未知错误'
            failedFiles.push({ path, reason })
            console.error(`[knowledge] 导入文件失败: ${path}`, reason)
            emit('parsing', path)
          }
        })
      )
      await new Promise((r) => setImmediate(r))
    }

    onProgress?.({
      phase: 'done',
      filesTotal: files.length,
      filesProcessed: processed,
      chunksEmbedded: embedded,
      warnings: warnings.length > 0 ? warnings : undefined
    })
    return {
      imported,
      skipped,
      failed,
      failedFiles: failedFiles.length > 0 ? failedFiles : undefined,
      warnings: warnings.length > 0 ? warnings : undefined
    }
  } catch (e) {
    onProgress?.({
      phase: 'error',
      filesTotal: 0,
      filesProcessed: 0,
      chunksEmbedded: embedded,
      error: e instanceof Error ? e.message : '导入失败'
    })
    throw e
  } finally {
    importing = false
  }
}

// 重建知识库：清空向量，重新解析和向量化所有文档（文档路径不变）。
// 用于更换 embedding 模型或修复索引损坏时。
export async function rebuildKnowledge(
  kbId: string,
  onProgress?: ProgressCb,
  signal?: AbortSignal
): Promise<ImportResult> {
  if (importing) throw new Error('知识库正在导入中')
  importing = true
  let rebuilt = 0
  let failed = 0
  let embedded = 0
  const failedFiles: Array<{ path: string; reason: string }> = []
  const warnings: Array<{ path: string; message: string }> = []
  try {
    const docs = listDocs(kbId)
    if (docs.length === 0) {
      onProgress?.({ phase: 'done', filesTotal: 0, filesProcessed: 0, chunksEmbedded: 0 })
      return { imported: 0, skipped: 0, failed: 0 }
    }

    clearKbVectors(kbId)
    onProgress?.({ phase: 'scanning', filesTotal: docs.length, filesProcessed: 0, chunksEmbedded: 0 })

    let processed = 0
    let lastEmit = 0
    const emit = (phase: ImportProgress['phase'], currentFile?: string): void => {
      const now = Date.now()
      if (phase === 'done' || phase === 'error' || now - lastEmit >= 150) {
        lastEmit = now
        onProgress?.({
          phase,
          filesTotal: docs.length,
          filesProcessed: processed,
          chunksEmbedded: embedded,
          currentFile,
          warnings: warnings.length > 0 ? warnings : undefined
        })
      }
    }

    for (const doc of docs) {
      if (signal?.aborted) throw new Error('重建已取消')
      processed++
      try {
        const stat = await fs.stat(doc.path)
        if (stat.size === 0) {
          failed++
          failedFiles.push({ path: doc.path, reason: '文件为空' })
          emit('parsing', doc.path)
          continue
        }
        if (stat.size > MAX_DOC_BYTES) {
          failed++
          failedFiles.push({ path: doc.path, reason: `文件过大 (${Math.round(stat.size / 1024 / 1024)}MB > 20MB)` })
          emit('parsing', doc.path)
          continue
        }

        emit('parsing', doc.path)
        const parsed = await parseDocument(doc.path)

        // 收集警告信息
        if (parsed.warning) {
          warnings.push({ path: doc.path, message: parsed.warning })
        }

        // 修复：二进制文件用 Buffer 计算 hash
        const content = await fs.readFile(doc.path)
        const hash = hashContent(content)

        const chunks = chunkDocument(parsed.text)
        if (chunks.length === 0) {
          failed++
          failedFiles.push({ path: doc.path, reason: '解析后无有效内容' })
          emit('parsing', doc.path)
          continue
        }

        emit('embedding', doc.path)
        const vectors = await embedTexts(chunks.map((c) => c.text))
        const rows: ChunkInsert[] = chunks.map((c, i) => ({
          text: c.text,
          heading: c.heading,
          ordinal: c.ordinal,
          vector: vectors[i]
        }))

        // 删除旧文档元数据，写入新版本。用队列串行写入。
        await dbWriteQueue.add(async () => {
          deleteDoc(doc.id)
          insertDoc(
            {
              id: randomUUID(),
              kbId,
              path: doc.path,
              title: parsed.title || basename(doc.path, extname(doc.path)),
              hash
            },
            rows
          )
        })
        embedded += rows.length
        rebuilt++
        emit('embedding', doc.path)
        await new Promise((r) => setImmediate(r))
      } catch (e) {
        failed++
        const reason = e instanceof Error ? e.message : '未知错误'
        failedFiles.push({ path: doc.path, reason })
        console.error(`[knowledge] 重建文件失败: ${doc.path}`, reason)
        emit('parsing', doc.path)
      }
    }

    onProgress?.({
      phase: 'done',
      filesTotal: docs.length,
      filesProcessed: processed,
      chunksEmbedded: embedded,
      warnings: warnings.length > 0 ? warnings : undefined
    })
    return {
      imported: rebuilt,
      skipped: 0,
      failed,
      failedFiles: failedFiles.length > 0 ? failedFiles : undefined,
      warnings: warnings.length > 0 ? warnings : undefined
    }
  } catch (e) {
    onProgress?.({
      phase: 'error',
      filesTotal: 0,
      filesProcessed: 0,
      chunksEmbedded: embedded,
      error: e instanceof Error ? e.message : '重建失败'
    })
    throw e
  } finally {
    importing = false
  }
}
