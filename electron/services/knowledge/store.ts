import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { KB_EMBED_DIM, KB_EMBED_MODEL_ID } from './embedService'

// 知识库向量存储：better-sqlite3 + sqlite-vec。
// better-sqlite3 是 Node 原生模块（需按 Electron ABI 编译），sqlite-vec 是可加载扩展。
// 两者都懒加载：未就绪时抛出可读错误，不拖垮主进程启动。

export interface KbRow {
  id: string
  name: string
  model: string
  dim: number
  createdAt: number
}

export interface DocRow {
  id: string
  kbId: string
  path: string
  title: string
  hash: string
  chunkCount: number
  addedAt: number
}

export interface ChunkInsert {
  text: string
  heading: string
  ordinal: number
  vector: number[]
}

export interface ChunkHit {
  docId: string
  path: string
  title: string
  heading: string
  ordinal: number
  text: string
  score: number
}

// better-sqlite3 的最小类型契约（避免强依赖其类型在原生模块缺失时报错）。
interface SqliteStatement {
  run(...args: unknown[]): unknown
  get(...args: unknown[]): unknown
  all(...args: unknown[]): unknown[]
}
interface SqliteDb {
  prepare(sql: string): SqliteStatement
  exec(sql: string): void
  loadExtension(path: string): void
  pragma(s: string): unknown
  close(): void
}

let db: SqliteDb | null = null
let loadError: string | null = null

function dbPath(): string {
  const dir = join(app.getPath('userData'), 'knowledge')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'knowledge.db')
}

/** Packaged app keeps native binaries under app.asar.unpacked; dev uses project node_modules. */
function nodeModulesRoot(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'app.asar.unpacked', 'node_modules')
  }
  return join(app.getAppPath(), 'node_modules')
}

function betterSqliteNativePath(): string | null {
  const p = join(nodeModulesRoot(), 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')
  return existsSync(p) ? p : null
}

function sqliteVecExtensionPath(): string | null {
  const { platform, arch } = process
  const ext = platform === 'win32' ? 'dll' : platform === 'darwin' ? 'dylib' : 'so'
  const os = platform === 'win32' ? 'windows' : platform
  const pkg = `sqlite-vec-${os}-${arch}`
  const candidates = [
    join(nodeModulesRoot(), 'sqlite-vec', 'node_modules', pkg, `vec0.${ext}`),
    join(nodeModulesRoot(), pkg, `vec0.${ext}`)
  ]
  return candidates.find((p) => existsSync(p)) ?? null
}

function openDatabase(file: string): SqliteDb {
  const nativeBinding = betterSqliteNativePath()
  const modRoot = join(nodeModulesRoot(), 'better-sqlite3')
  const Database = (
    existsSync(join(modRoot, 'package.json')) ? require(modRoot) : require('better-sqlite3')
  ) as new (path: string, opts?: { nativeBinding?: string }) => SqliteDb
  return nativeBinding ? new Database(file, { nativeBinding }) : new Database(file)
}

function loadVecExtension(instance: SqliteDb): void {
  const unpacked = sqliteVecExtensionPath()
  if (unpacked) {
    instance.loadExtension(unpacked)
    return
  }
  const sqliteVec = require('sqlite-vec') as { load: (db: unknown) => void }
  sqliteVec.load(instance)
}

// 懒加载并初始化数据库；失败时缓存错误信息。
function getDb(): SqliteDb {
  if (db) return db
  if (loadError) throw new Error(loadError)
  try {
    const instance = openDatabase(dbPath())
    instance.pragma('journal_mode = WAL')
    loadVecExtension(instance)
    initSchema(instance)
    db = instance
    return db
  } catch (e) {
    loadError =
      'knowledge: 无法加载向量数据库（better-sqlite3 / sqlite-vec）。' +
      (app.isPackaged
        ? '安装包内原生组件缺失或损坏，请重新下载安装。'
        : '请确保已按 Electron 版本重新编译原生模块（npm run rebuild:native）。') +
      '原始错误：' +
      (e instanceof Error ? e.message : String(e))
    throw new Error(loadError)
  }
}

function initSchema(instance: SqliteDb): void {
  instance.exec(`
    CREATE TABLE IF NOT EXISTS kb (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      model TEXT NOT NULL,
      dim INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS doc (
      id TEXT PRIMARY KEY,
      kb_id TEXT NOT NULL,
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      hash TEXT NOT NULL,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      added_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_doc_kb ON doc(kb_id);
    CREATE TABLE IF NOT EXISTS chunk (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id TEXT NOT NULL,
      kb_id TEXT NOT NULL,
      heading TEXT NOT NULL DEFAULT '',
      ordinal INTEGER NOT NULL,
      text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chunk_doc ON chunk(doc_id);
    CREATE INDEX IF NOT EXISTS idx_chunk_kb ON chunk(kb_id);
  `)
  // 向量虚拟表：维度固定为知识库中文模型维度（512）。
  instance.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunk USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[${KB_EMBED_DIM}]);`
  )
}

// 探测存储是否可用（供 IPC status 报告原生模块状态）。
export function probeStore(): { ok: boolean; error?: string } {
  try {
    getDb()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export function createKb(id: string, name: string): void {
  const d = getDb()
  d.prepare('INSERT INTO kb (id, name, model, dim, created_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    name,
    KB_EMBED_MODEL_ID,
    KB_EMBED_DIM,
    Date.now()
  )
}

export function listKbs(): KbRow[] {
  const d = getDb()
  const rows = d.prepare('SELECT id, name, model, dim, created_at AS createdAt FROM kb ORDER BY created_at').all()
  return rows as KbRow[]
}

export function getKb(id: string): KbRow | null {
  const d = getDb()
  const row = d.prepare('SELECT id, name, model, dim, created_at AS createdAt FROM kb WHERE id = ?').get(id)
  return (row as KbRow) ?? null
}

export function deleteKb(id: string): void {
  const d = getDb()
  // 用 better-sqlite3 的事务 API 包装，确保原子性：任一步骤失败则全部回滚。
  const tx = (d as any).transaction(() => {
    d.prepare('DELETE FROM vec_chunk WHERE chunk_id IN (SELECT id FROM chunk WHERE kb_id = ?)').run(id)
    d.prepare('DELETE FROM chunk WHERE kb_id = ?').run(id)
    d.prepare('DELETE FROM doc WHERE kb_id = ?').run(id)
    d.prepare('DELETE FROM kb WHERE id = ?').run(id)
  })
  tx()
}

export function listDocs(kbId: string): DocRow[] {
  const d = getDb()
  const rows = d
    .prepare(
      'SELECT id, kb_id AS kbId, path, title, hash, chunk_count AS chunkCount, added_at AS addedAt FROM doc WHERE kb_id = ? ORDER BY added_at'
    )
    .all(kbId)
  return rows as DocRow[]
}

export function getDocByPath(kbId: string, path: string): DocRow | null {
  const d = getDb()
  const row = d
    .prepare(
      'SELECT id, kb_id AS kbId, path, title, hash, chunk_count AS chunkCount, added_at AS addedAt FROM doc WHERE kb_id = ? AND path = ?'
    )
    .get(kbId, path)
  return (row as DocRow) ?? null
}

// 删除某文档及其所有 chunk/向量（用于重导入或移除）。
export function deleteDoc(docId: string): void {
  const d = getDb()
  d.prepare('DELETE FROM vec_chunk WHERE chunk_id IN (SELECT id FROM chunk WHERE doc_id = ?)').run(docId)
  d.prepare('DELETE FROM chunk WHERE doc_id = ?').run(docId)
  d.prepare('DELETE FROM doc WHERE id = ?').run(docId)
}

// 清空知识库的所有向量（保留文档元数据），用于重建索引。
export function clearKbVectors(kbId: string): void {
  const d = getDb()
  const tx = (d as any).transaction(() => {
    d.prepare('DELETE FROM vec_chunk WHERE chunk_id IN (SELECT id FROM chunk WHERE kb_id = ?)').run(kbId)
    d.prepare('DELETE FROM chunk WHERE kb_id = ?').run(kbId)
    d.prepare('UPDATE doc SET chunk_count = 0 WHERE kb_id = ?').run(kbId)
  })
  tx()
}

function toBlob(vec: number[]): Buffer {
  const f32 = new Float32Array(vec)
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength)
}

// 写入一个文档的全部 chunk + 向量（已先删除旧版本）。
export function insertDoc(
  doc: { id: string; kbId: string; path: string; title: string; hash: string },
  chunks: ChunkInsert[]
): void {
  const d = getDb()
  // 用事务包装 doc + chunks + vectors 的批量写入，确保原子性。
  const tx = (d as any).transaction(() => {
    d.prepare(
      'INSERT INTO doc (id, kb_id, path, title, hash, chunk_count, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(doc.id, doc.kbId, doc.path, doc.title, doc.hash, chunks.length, Date.now())

    const insChunk = d.prepare(
      'INSERT INTO chunk (doc_id, kb_id, heading, ordinal, text) VALUES (?, ?, ?, ?, ?)'
    )
    const insVec = d.prepare('INSERT INTO vec_chunk (chunk_id, embedding) VALUES (?, ?)')
    for (const c of chunks) {
      const res = insChunk.run(doc.id, doc.kbId, c.heading, c.ordinal, c.text) as { lastInsertRowid: number | bigint }
      const chunkId = Number(res.lastInsertRowid)
      // sqlite-vec 的 vec0 主键要求 BigInt 绑定；向量以 Float32 BLOB 写入。
      insVec.run(BigInt(chunkId), toBlob(c.vector))
    }
  })
  tx()
}

export interface KbStats {
  docCount: number
  chunkCount: number
}

export interface KbHealthCheck {
  ok: boolean
  issues: string[]
  stats: {
    orphanChunks: number       // chunk 表中 doc_id 不在 doc 表的记录数
    orphanVectors: number      // vec_chunk 中 chunk_id 不在 chunk 表的记录数
    inconsistentDocs: number   // doc.chunk_count 与实际 chunk 数不一致的文档数
    modelMismatch: boolean     // kb.model/dim 与当前 KB_EMBED_MODEL_ID/KB_EMBED_DIM 不一致
  }
}

export function kbStats(kbId: string): KbStats {
  const d = getDb()
  const docRow = d.prepare('SELECT COUNT(*) AS n FROM doc WHERE kb_id = ?').get(kbId) as { n: number }
  const chunkRow = d.prepare('SELECT COUNT(*) AS n FROM chunk WHERE kb_id = ?').get(kbId) as { n: number }
  return { docCount: docRow.n, chunkCount: chunkRow.n }
}

// 健康检查：检测知识库的完整性与一致性问题。
export function healthCheck(kbId: string): KbHealthCheck {
  const d = getDb()
  const issues: string[] = []

  // 检查孤儿 chunk（doc_id 不在 doc 表）
  const orphanChunkRow = d.prepare(`
    SELECT COUNT(*) AS n FROM chunk
    WHERE kb_id = ? AND doc_id NOT IN (SELECT id FROM doc WHERE kb_id = ?)
  `).get(kbId, kbId) as { n: number }
  const orphanChunks = orphanChunkRow.n
  if (orphanChunks > 0) issues.push(`${orphanChunks} 个孤儿 chunk（文档已删除但 chunk 未清理）`)

  // 检查孤儿向量（chunk_id 不在 chunk 表）
  const orphanVecRow = d.prepare(`
    SELECT COUNT(*) AS n FROM vec_chunk
    WHERE chunk_id NOT IN (SELECT id FROM chunk WHERE kb_id = ?)
  `).get(kbId) as { n: number }
  const orphanVectors = orphanVecRow.n
  if (orphanVectors > 0) issues.push(`${orphanVectors} 个孤儿向量（chunk 已删除但向量未清理）`)

  // 检查 doc.chunk_count 不一致
  const inconsistentRow = d.prepare(`
    SELECT COUNT(*) AS n FROM doc
    WHERE kb_id = ? AND chunk_count != (
      SELECT COUNT(*) FROM chunk WHERE doc_id = doc.id
    )
  `).get(kbId) as { n: number }
  const inconsistentDocs = inconsistentRow.n
  if (inconsistentDocs > 0) issues.push(`${inconsistentDocs} 篇文档的 chunk 计数不一致`)

  // 检查 embedding 模型是否与当前不匹配
  const kb = getKb(kbId)
  const modelMismatch = kb ? (kb.model !== KB_EMBED_MODEL_ID || kb.dim !== KB_EMBED_DIM) : false
  if (modelMismatch) {
    issues.push(`embedding 模型不匹配（库: ${kb?.model ?? '?'}, 当前: ${KB_EMBED_MODEL_ID}）。建议重建索引。`)
  }

  return {
    ok: issues.length === 0,
    issues,
    stats: { orphanChunks, orphanVectors, inconsistentDocs, modelMismatch }
  }
}

// 修复知识库的完整性问题：清理孤儿 chunk 和孤儿向量，修正 chunk_count。
export function repairKb(kbId: string): { fixed: number } {
  const d = getDb()
  let fixed = 0

  const tx = (d as any).transaction(() => {
    // 1. 清理孤儿 chunk
    const r1 = d.prepare(`
      DELETE FROM chunk WHERE kb_id = ? AND doc_id NOT IN (SELECT id FROM doc WHERE kb_id = ?)
    `).run(kbId, kbId) as { changes: number }
    fixed += r1.changes

    // 2. 清理孤儿向量（chunk_id 不在 chunk 表）
    const r2 = d.prepare(`
      DELETE FROM vec_chunk WHERE chunk_id NOT IN (SELECT id FROM chunk)
    `).run() as { changes: number }
    fixed += r2.changes

    // 3. 修正所有文档的 chunk_count
    const docs = d.prepare('SELECT id FROM doc WHERE kb_id = ?').all(kbId) as Array<{ id: string }>
    for (const doc of docs) {
      const actualCount = (d.prepare('SELECT COUNT(*) AS n FROM chunk WHERE doc_id = ?').get(doc.id) as { n: number }).n
      d.prepare('UPDATE doc SET chunk_count = ? WHERE id = ?').run(actualCount, doc.id)
    }
  })
  tx()

  return { fixed }
}

// 导出知识库元数据（不含向量，便于备份/迁移）。
export interface KbExport {
  kb: KbRow
  docs: Array<{ id: string; path: string; title: string; hash: string; addedAt: number }>
}

export function exportKb(kbId: string): KbExport | null {
  const d = getDb()
  const kb = getKb(kbId)
  if (!kb) return null

  const docs = d.prepare(`
    SELECT id, path, title, hash, added_at AS addedAt FROM doc WHERE kb_id = ? ORDER BY added_at
  `).all(kbId) as Array<{ id: string; path: string; title: string; hash: string; addedAt: number }>

  return { kb, docs }
}

// 检测过期文档：文档文件已变更（hash 不匹配）或已删除。
export interface OutdatedDoc {
  id: string
  path: string
  title: string
  reason: 'modified' | 'deleted'
}

export async function findOutdatedDocs(kbId: string): Promise<OutdatedDoc[]> {
  const docs = listDocs(kbId)
  const outdated: OutdatedDoc[] = []
  const { promises: fs } = await import('fs')
  const { createHash } = await import('crypto')

  for (const doc of docs) {
    try {
      const content = await fs.readFile(doc.path, 'utf8')
      const currentHash = createHash('sha1').update(content).digest('hex')
      if (currentHash !== doc.hash) {
        outdated.push({ id: doc.id, path: doc.path, title: doc.title, reason: 'modified' })
      }
    } catch {
      // 文件不存在或无法读取
      outdated.push({ id: doc.id, path: doc.path, title: doc.title, reason: 'deleted' })
    }
  }

  return outdated
}

// KNN 检索：在指定知识库内找与查询向量最相近的 topK 个 chunk。
export function searchChunks(kbId: string, queryVec: number[], topK: number): ChunkHit[] {
  const d = getDb()
  const rows = d
    .prepare(
      `SELECT c.doc_id AS docId, c.heading AS heading, c.ordinal AS ordinal, c.text AS text,
              d.path AS path, d.title AS title, v.distance AS distance
       FROM vec_chunk v
       JOIN chunk c ON c.id = v.chunk_id
       JOIN doc d ON d.id = c.doc_id
       WHERE c.kb_id = ? AND v.embedding MATCH ? AND k = ?
       ORDER BY v.distance`
    )
    .all(kbId, toBlob(queryVec), topK) as Array<{
    docId: string
    heading: string
    ordinal: number
    text: string
    path: string
    title: string
    distance: number
  }>
  // sqlite-vec 默认返回 L2 距离；向量已归一化，转成相似度便于阅读（越大越相关）。
  return rows.map((r) => ({
    docId: r.docId,
    path: r.path,
    title: r.title,
    heading: r.heading,
    ordinal: r.ordinal,
    text: r.text,
    score: 1 - r.distance / 2
  }))
}

export function closeStore(): void {
  if (db) {
    try {
      db.close()
    } catch {
      // ignore
    }
    db = null
  }
}
