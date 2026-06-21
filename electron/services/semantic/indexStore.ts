import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { EMBED_DIM, EMBED_MODEL_ID } from './embedService'

export interface IndexedChunk {
  startLine: number
  endLine: number
  text: string
  vector: number[]
}

export interface IndexedFile {
  hash: string
  chunks: IndexedChunk[]
}

export interface SemanticIndex {
  version: number
  model: string
  dim: number
  files: Record<string, IndexedFile>
}

const INDEX_VERSION = 1

export function hashContent(content: string): string {
  return createHash('sha1').update(content).digest('hex')
}

function indexDir(): string {
  return join(app.getPath('userData'), 'semantic-index')
}

// 用工作区路径的 hash 作为索引文件名，做到一个工作区一份索引。
function indexFileFor(workspaceRoot: string): string {
  const key = createHash('sha1').update(workspaceRoot.toLowerCase()).digest('hex').slice(0, 16)
  return join(indexDir(), `${key}.json`)
}

export function emptyIndex(): SemanticIndex {
  return { version: INDEX_VERSION, model: EMBED_MODEL_ID, dim: EMBED_DIM, files: {} }
}

export async function loadIndex(workspaceRoot: string): Promise<SemanticIndex> {
  try {
    const raw = await fs.readFile(indexFileFor(workspaceRoot), 'utf8')
    const parsed = JSON.parse(raw) as SemanticIndex
    // 模型或版本变化则作废重建，避免维度不一致。
    if (parsed.version !== INDEX_VERSION || parsed.model !== EMBED_MODEL_ID || parsed.dim !== EMBED_DIM) {
      return emptyIndex()
    }
    if (!parsed.files || typeof parsed.files !== 'object') return emptyIndex()
    return parsed
  } catch {
    return emptyIndex()
  }
}

export async function saveIndex(workspaceRoot: string, index: SemanticIndex): Promise<void> {
  const dir = indexDir()
  await fs.mkdir(dir, { recursive: true })
  const target = indexFileFor(workspaceRoot)
  const tmp = `${target}.${Date.now()}.tmp`
  await fs.writeFile(tmp, JSON.stringify(index), 'utf8')
  await fs.rename(tmp, target)
}

export async function deleteIndex(workspaceRoot: string): Promise<void> {
  await fs.rm(indexFileFor(workspaceRoot), { force: true }).catch(() => {})
}
