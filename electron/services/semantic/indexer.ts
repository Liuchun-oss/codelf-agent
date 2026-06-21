import { promises as fs } from 'fs'
import { join } from 'path'
import type { Ignore } from 'ignore'
import { buildIgnore, toRel } from '../fsService'
import { chunkFile, isChunkableCode } from './chunker'
import { embedTexts, embedOne } from './embedService'
import {
  loadIndex,
  saveIndex,
  hashContent,
  type SemanticIndex,
  type IndexedChunk
} from './indexStore'

const MAX_FILE_BYTES = 2 * 1024 * 1024

// 索引时硬忽略的目录（不依赖 .gitignore，避免误扫 node_modules 等导致文件爆炸）。
const HEAVY_IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', 'release', 'build', 'target',
  '.next', '.nuxt', '.turbo', '.vite', '.cache', '.parcel-cache',
  '__pycache__', '.venv', 'venv', 'env', '.tox', '.mypy_cache', '.pytest_cache',
  'vendor', 'bower_components', '.gradle', '.idea', '.vscode', 'coverage',
  '.svn', '.hg', 'tmp', 'temp', 'logs', '.codelf'
])

// 单个工作区最多索引的文件数，超出则截断，防止超大仓库拖垮机器。
const MAX_INDEX_FILES = 5000

// 超过此阈值则不自动构建，改由用户手动触发，避免大仓库首次构建拖慢机器。
export const AUTO_INDEX_FILE_LIMIT = 2000

export interface IndexProgress {
  phase: 'scanning' | 'embedding' | 'done' | 'error'
  filesTotal: number
  filesProcessed: number
  chunksEmbedded: number
  error?: string
}

export interface SemanticHit {
  path: string
  startLine: number
  endLine: number
  score: number
  text: string
}

type ProgressCb = (p: IndexProgress) => void

function isBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 8000))
  for (let i = 0; i < sample.length; i++) if (sample[i] === 0) return true
  return false
}

async function collectFiles(root: string, ig: Ignore | null): Promise<{ files: string[]; capped: boolean }> {
  const out: string[] = []
  let capped = false
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 40 || out.length >= MAX_INDEX_FILES) {
      if (out.length >= MAX_INDEX_FILES) capped = true
      return
    }
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= MAX_INDEX_FILES) {
        capped = true
        return
      }
      // 硬忽略重目录，不依赖 .gitignore。
      if (HEAVY_IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      const isDir = entry.isDirectory()
      if (ig) {
        const rel = toRel(root, full) + (isDir ? '/' : '')
        if (rel && ig.ignores(rel)) continue
      }
      if (isDir) await walk(full, depth + 1)
      else if (entry.isFile() && isChunkableCode(entry.name)) out.push(full)
    }
  }
  await walk(root, 0)
  return { files: out, capped }
}

// 快速估算可索引文件数（不读内容/不切块/不推理），用于决定是否自动构建。
export async function countIndexableFiles(workspaceRoot: string): Promise<number> {
  const ig = await buildIgnore(workspaceRoot)
  const { files } = await collectFiles(workspaceRoot, ig)
  return files.length
}

// 读取并切块单个文件，返回 {hash, chunks文本}；跳过过大/二进制/空文件。
async function readChunks(
  path: string,
  rel: string
): Promise<{ hash: string; chunks: { startLine: number; endLine: number; text: string }[] } | null> {
  try {
    const stat = await fs.stat(path)
    if (stat.size > MAX_FILE_BYTES || stat.size === 0) return null
    const buf = await fs.readFile(path)
    if (isBinary(buf)) return null
    const content = buf.toString('utf8')
    return { hash: hashContent(content), chunks: chunkFile(rel, content) }
  } catch {
    return null
  }
}

let building = false

export function isBuilding(): boolean {
  return building
}

// 全量/增量构建：未变更的文件复用旧向量，只对新增/修改的文件重新 embedding。
export async function buildIndex(
  workspaceRoot: string,
  onProgress?: ProgressCb,
  signal?: AbortSignal
): Promise<SemanticIndex> {
  if (building) throw new Error('索引正在构建中')
  building = true
  try {
    const ig = await buildIgnore(workspaceRoot)
    const { files, capped } = await collectFiles(workspaceRoot, ig)
    const old = await loadIndex(workspaceRoot)
    const next: SemanticIndex = { ...old, files: {} }

    onProgress?.({ phase: 'scanning', filesTotal: files.length, filesProcessed: 0, chunksEmbedded: 0 })

    let processed = 0
    let embedded = 0
    let lastEmit = 0
    const seen = new Set<string>()

    // 进度事件节流：避免上万文件时每文件一次 IPC 把渲染进程冲垮。
    const emit = (phase: IndexProgress['phase']): void => {
      const now = Date.now()
      if (phase === 'done' || phase === 'error' || now - lastEmit >= 200) {
        lastEmit = now
        onProgress?.({ phase, filesTotal: files.length, filesProcessed: processed, chunksEmbedded: embedded })
      }
    }

    for (const path of files) {
      if (signal?.aborted) throw new Error('索引已取消')
      const rel = toRel(workspaceRoot, path)
      seen.add(rel)
      const result = await readChunks(path, rel)
      processed++
      if (!result) {
        emit('embedding')
        continue
      }

      const prev = old.files[rel]
      if (prev && prev.hash === result.hash) {
        // 文件未变化，直接复用旧向量。
        next.files[rel] = prev
      } else {
        const vectors = await embedTexts(result.chunks.map((c) => c.text))
        const chunks: IndexedChunk[] = result.chunks.map((c, i) => ({
          startLine: c.startLine,
          endLine: c.endLine,
          text: c.text,
          vector: vectors[i]
        }))
        next.files[rel] = { hash: result.hash, chunks }
        embedded += chunks.length
        // 每处理完一个需要计算的文件，让出事件循环，避免堵死主进程 UI。
        await new Promise((r) => setImmediate(r))
      }
      emit('embedding')
    }

    await saveIndex(workspaceRoot, next)
    onProgress?.({ phase: 'done', filesTotal: files.length, filesProcessed: processed, chunksEmbedded: embedded })
    if (capped) {
      console.warn(`[semantic] 工作区文件超过 ${MAX_INDEX_FILES}，已截断索引`)
    }
    return next
  } finally {
    building = false
  }
}

// 增量更新指定文件（保存时调用）：重新切块+embedding 并落盘。
export async function updateFiles(workspaceRoot: string, absPaths: string[]): Promise<void> {
  if (building) return
  const index = await loadIndex(workspaceRoot)
  let changed = false
  for (const path of absPaths) {
    const rel = toRel(workspaceRoot, path)
    if (!isChunkableCode(rel)) continue
    const result = await readChunks(path, rel)
    if (!result) {
      // 文件被删或读不到，从索引移除。
      if (index.files[rel]) {
        delete index.files[rel]
        changed = true
      }
      continue
    }
    const prev = index.files[rel]
    if (prev && prev.hash === result.hash) continue
    const vectors = await embedTexts(result.chunks.map((c) => c.text))
    index.files[rel] = {
      hash: result.hash,
      chunks: result.chunks.map((c, i) => ({
        startLine: c.startLine,
        endLine: c.endLine,
        text: c.text,
        vector: vectors[i]
      }))
    }
    changed = true
  }
  if (changed) await saveIndex(workspaceRoot, index)
}

function dot(a: number[], b: number[]): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

// 语义检索：把查询向量与索引内所有块算余弦相似度，返回 Top K。
export async function semanticSearch(
  workspaceRoot: string,
  query: string,
  topK = 15
): Promise<{ ok: boolean; hits: SemanticHit[]; indexed: boolean; error?: string }> {
  const index = await loadIndex(workspaceRoot)
  const fileEntries = Object.entries(index.files)
  if (fileEntries.length === 0) return { ok: true, hits: [], indexed: false }

  let qvec: number[]
  try {
    qvec = await embedOne(query)
  } catch (e) {
    return { ok: false, hits: [], indexed: true, error: e instanceof Error ? e.message : '查询向量计算失败' }
  }

  const hits: SemanticHit[] = []
  for (const [rel, file] of fileEntries) {
    for (const chunk of file.chunks) {
      if (chunk.vector.length !== qvec.length) continue
      hits.push({
        path: rel,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        score: dot(qvec, chunk.vector),
        text: chunk.text
      })
    }
  }
  hits.sort((a, b) => b.score - a.score)
  return { ok: true, hits: hits.slice(0, topK), indexed: true }
}
