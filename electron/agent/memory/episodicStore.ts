import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { KB_EMBED_DIM, KB_EMBED_MODEL_ID } from '../../services/knowledge/embedService'

// 情景记忆库（轨道 A）：better-sqlite3 + sqlite-vec，独立于知识库的 episodic.db。
// 复用知识库同款原生组件加载与懒加载容错：原生模块缺失时抛可读错误，绝不拖垮主进程启动。
// 维度沿用 bge-small-zh-v1.5（512），与知识库共用同一 embedding 进程，零额外模型开销。
//
// 设计契约（与记忆系统整体方案一致）：
// - best-effort：任何读写失败都被上层吞掉，绝不影响主对话。
// - 一条记忆 = 一个原子事件/一句关键对话；带 salience/strength/激活次数/代码锚，支持后续衰减与联想。
// - 物理路径由系统侧计算，Agent 不接触；scope/project_id/session_id 沿用现有隔离口径。

export type EpisodicScope = 'session' | 'project' | 'global'
export type EpisodicState = 'active' | 'dormant' | 'archived'

export interface EpisodicInsert {
  id: string
  scope: EpisodicScope
  projectId?: string | null
  sessionId?: string | null
  kind: string
  content: string
  summary?: string | null
  anchorFile?: string | null
  anchorSymbol?: string | null
  salience: number
  vector: number[]
}

export interface EpisodicHit {
  id: string
  scope: EpisodicScope
  projectId: string | null
  sessionId: string | null
  kind: string
  content: string
  summary: string | null
  anchorFile: string | null
  anchorSymbol: string | null
  salience: number
  strength: number
  score: number
  createdAt?: number
}

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
  const dir = join(app.getPath('userData'), 'memory')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'episodic.db')
}

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
      'episodic: 无法加载情景记忆向量库（better-sqlite3 / sqlite-vec）。' +
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
    CREATE TABLE IF NOT EXISTS episodic (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      project_id TEXT,
      session_id TEXT,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      summary TEXT,
      anchor_file TEXT,
      anchor_symbol TEXT,
      salience REAL NOT NULL DEFAULT 0.4,
      activations INTEGER NOT NULL DEFAULT 1,
      strength REAL NOT NULL DEFAULT 1.0,
      tau REAL NOT NULL DEFAULT 1209600,
      state TEXT NOT NULL DEFAULT 'active',
      model TEXT NOT NULL DEFAULT '',
      consolidated INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_access INTEGER NOT NULL,
      superseded_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_epi_scope ON episodic(scope);
    CREATE INDEX IF NOT EXISTS idx_epi_project ON episodic(project_id);
    CREATE INDEX IF NOT EXISTS idx_epi_session ON episodic(session_id);
    CREATE INDEX IF NOT EXISTS idx_epi_state ON episodic(state);
    CREATE TABLE IF NOT EXISTS episodic_edges (
      src TEXT NOT NULL,
      dst TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0,
      PRIMARY KEY (src, dst)
    );
  `)
  instance.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS vec_episodic USING vec0(epi_id TEXT PRIMARY KEY, embedding float[${KB_EMBED_DIM}]);`
  )
  // 轻量迁移：早期 dev 库可能无 consolidated 列，补加（已存在则忽略错误）。
  try {
    instance.exec(`ALTER TABLE episodic ADD COLUMN consolidated INTEGER NOT NULL DEFAULT 0;`)
  } catch {
    // 列已存在
  }
}

/** 探测情景库是否可用（供诊断 / IPC status）。 */
export function probeEpisodicStore(): { ok: boolean; error?: string } {
  try {
    getDb()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export const EPISODIC_EMBED_MODEL = KB_EMBED_MODEL_ID

function toBlob(vec: number[]): Buffer {
  const f32 = new Float32Array(vec)
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength)
}

/** 由 salience 推半衰期 τ（秒）：高显著记得久。基准 14 天，最高约 90 天。 */
function tauFromSalience(salience: number): number {
  const base = 14 * 24 * 3600
  return base * (1 + Math.max(0, Math.min(1, salience)) * 5.5)
}

/** 插入一条情景记忆 + 其向量（事务原子写）。best-effort，调用方应捕获异常。 */
export function insertEpisode(e: EpisodicInsert, model = ''): void {
  const d = getDb()
  const now = Date.now()
  const tau = tauFromSalience(e.salience)
  const tx = (d as any).transaction(() => {
    d.prepare(
      `INSERT INTO episodic
        (id, scope, project_id, session_id, kind, content, summary, anchor_file, anchor_symbol,
         salience, activations, strength, tau, state, model, created_at, last_access, superseded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1.0, ?, 'active', ?, ?, ?, NULL)`
    ).run(
      e.id, e.scope, e.projectId ?? null, e.sessionId ?? null, e.kind, e.content,
      e.summary ?? null, e.anchorFile ?? null, e.anchorSymbol ?? null,
      e.salience, tau, model, now, now
    )
    d.prepare('INSERT INTO vec_episodic (epi_id, embedding) VALUES (?, ?)').run(e.id, toBlob(e.vector))
  })
  tx()
}

/** 计算某条记忆的实时强度：strength0 × exp(-Δt/τ)，Δt 为距上次访问的秒数。 */
function liveStrength(strength: number, lastAccess: number, tau: number, now: number): number {
  const dt = Math.max(0, (now - lastAccess) / 1000)
  return strength * Math.exp(-dt / Math.max(1, tau))
}

export interface RecallParams {
  queryVec: number[]
  topK: number
  /** 限定项目；传入则优先本项目，但不排除 global 与其他项目（跨项目召回）。 */
  projectId?: string | null
  /** 仅召回 active/dormant，不含 archived。 */
  includeDormant?: boolean
  /**
   * 会话隔离：传入后，非 global 的记忆只保留 sessionId 严格匹配本会话的，
   * 排除同工作区里「其他会话」写入的项目记忆（如群聊主管往共享工作区写的 note/todo）。
   * 用于微信这类线性对话，避免旧项目/多岗位记忆串味。global（身份/偏好）不受影响。
   */
  isolateSessionId?: string | null
}

/**
 * 向量 KNN 召回 + 衰减感知排序。返回综合分 = 语义相似度 × 实时强度 × (0.5+salience)。
 * 不在此处做副作用（命中增强由调用方在确认采用后单独触发），保持检索纯粹。
 */
export function recallEpisodes(p: RecallParams): EpisodicHit[] {
  const d = getDb()
  const now = Date.now()
  const k = Math.max(1, Math.min(50, p.topK))
  // 过量召回再按工作区过滤：KNN 无法直接过滤 join 表的 project_id，故取更多候选，
  // JS 侧只保留「本项目 + global（跨项目偏好）」，排除其他项目，避免串工作区。
  const probe = Math.max(k * 5, 30)
  const rows = d
    .prepare(
      `SELECT e.id, e.scope, e.project_id AS projectId, e.session_id AS sessionId, e.kind,
              e.content, e.summary, e.anchor_file AS anchorFile, e.anchor_symbol AS anchorSymbol,
              e.salience, e.strength, e.last_access AS lastAccess, e.tau, e.state,
              e.created_at AS createdAt, v.distance AS distance
       FROM vec_episodic v
       JOIN episodic e ON e.id = v.epi_id
       WHERE v.embedding MATCH ? AND k = ?
         AND e.superseded_by IS NULL
         AND e.state != 'archived'
       ORDER BY v.distance`
    )
    .all(toBlob(p.queryVec), probe) as Array<{
    id: string; scope: EpisodicScope; projectId: string | null; sessionId: string | null
    kind: string; content: string; summary: string | null; anchorFile: string | null
    anchorSymbol: string | null; salience: number; strength: number; lastAccess: number
    tau: number; state: string; createdAt: number; distance: number
  }>
  const wantProject = p.projectId ?? null
  const isolateSid = p.isolateSessionId ?? null
  return rows
    .filter((r) => r.scope === 'global' || (r.projectId ?? null) === wantProject)
    // 会话隔离：非 global 记忆必须来自本会话，杜绝共享工作区里其他会话（群聊主管等）串味。
    .filter((r) => !isolateSid || r.scope === 'global' || r.sessionId === isolateSid)
    .map((r) => {
      const sim = 1 - r.distance / 2
      const live = liveStrength(r.strength, r.lastAccess, r.tau, now)
      const score = sim * live * (0.5 + r.salience)
      return {
        id: r.id, scope: r.scope, projectId: r.projectId, sessionId: r.sessionId, kind: r.kind,
        content: r.content, summary: r.summary, anchorFile: r.anchorFile, anchorSymbol: r.anchorSymbol,
        salience: r.salience, strength: live, score, createdAt: r.createdAt
      } as EpisodicHit
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
}

/** 统计当前情景库记录数（诊断用）。 */
export function episodicCount(): number {
  const d = getDb()
  const row = d.prepare('SELECT COUNT(*) AS n FROM episodic').get() as { n: number }
  return row.n
}

/** 取某会话最近写入的 N 条记忆 id（用于写入时建联想边）。best-effort 返回空数组。 */
export function recentEpisodeIds(sessionId: string, limit = 5): string[] {
  try {
    const d = getDb()
    const rows = d
      .prepare(
        `SELECT id FROM episodic WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`
      )
      .all(sessionId, limit) as Array<{ id: string }>
    return rows.map((r) => r.id)
  } catch {
    return []
  }
}

/** 在新记忆与一组既有记忆间建立双向联想边（去重累加权重）。best-effort。 */
export function addEdges(srcId: string, dstIds: string[], weight = 1.0): void {
  if (dstIds.length === 0) return
  try {
    const d = getDb()
    const ins = d.prepare(
      `INSERT INTO episodic_edges (src, dst, weight) VALUES (?, ?, ?)
       ON CONFLICT(src, dst) DO UPDATE SET weight = weight + excluded.weight`
    )
    const tx = (d as any).transaction(() => {
      for (const dst of dstIds) {
        if (dst === srcId) continue
        ins.run(srcId, dst, weight)
        ins.run(dst, srcId, weight)
      }
    })
    tx()
  } catch {
    // best-effort
  }
}

/**
 * 模式完成（联想扩散，机制 1）：给定一批已命中记忆 id，沿 episodic_edges 扩一跳，
 * 召回强关联的邻居记忆（排除已命中的、已 supersede/archived 的）。best-effort。
 */
export function expandByEdges(seedIds: string[], limit = 3, projectId?: string | null, isolateSessionId?: string | null): EpisodicHit[] {
  if (seedIds.length === 0) return []
  try {
    const d = getDb()
    const now = Date.now()
    const placeholders = seedIds.map(() => '?').join(',')
    const rows = d
      .prepare(
        `SELECT e.id, e.scope, e.project_id AS projectId, e.session_id AS sessionId, e.kind,
                e.content, e.summary, e.anchor_file AS anchorFile, e.anchor_symbol AS anchorSymbol,
                e.salience, e.strength, e.last_access AS lastAccess, e.tau,
                SUM(g.weight) AS edgeWeight
         FROM episodic_edges g
         JOIN episodic e ON e.id = g.dst
         WHERE g.src IN (${placeholders})
           AND g.dst NOT IN (${placeholders})
           AND e.superseded_by IS NULL AND e.state != 'archived'
         GROUP BY e.id
         ORDER BY edgeWeight DESC
         LIMIT ?`
      )
      .all(...seedIds, ...seedIds, Math.max(limit * 4, 12)) as Array<{
      id: string; scope: EpisodicScope; projectId: string | null; sessionId: string | null
      kind: string; content: string; summary: string | null; anchorFile: string | null
      anchorSymbol: string | null; salience: number; strength: number; lastAccess: number
      tau: number; edgeWeight: number
    }>
    const wantProject = projectId ?? null
    const isolateSid = isolateSessionId ?? null
    return rows
      // 联想扩散同样受工作区隔离：只接受本项目或 global 的邻居，杜绝跨工作区串记忆。
      .filter((r) => r.scope === 'global' || (r.projectId ?? null) === wantProject)
      // 会话隔离：非 global 邻居必须来自本会话，防止沿边扩散把其他会话记忆带回来。
      .filter((r) => !isolateSid || r.scope === 'global' || r.sessionId === isolateSid)
      .slice(0, limit)
      .map((r) => {
      const live = liveStrength(r.strength, r.lastAccess, r.tau, now)
      return {
        id: r.id, scope: r.scope, projectId: r.projectId, sessionId: r.sessionId, kind: r.kind,
        content: r.content, summary: r.summary, anchorFile: r.anchorFile, anchorSymbol: r.anchorSymbol,
        salience: r.salience, strength: live, score: live * (0.5 + r.salience)
      } as EpisodicHit
    })
  } catch {
    return []
  }
}

/**
 * 命中再巩固（机制 4）：某条记忆被召回并采用后调用。
 * 提取增强——strength 回满、τ 变长（用得越多越难忘）、activations++、刷新 last_access。
 * best-effort，内部捕获异常。
 */
export function reinforceEpisode(id: string): void {
  try {
    const d = getDb()
    const now = Date.now()
    d.prepare(
      `UPDATE episodic
         SET activations = activations + 1,
             strength = 1.0,
             tau = MIN(tau * (1 + 0.3 * salience), ?),
             last_access = ?,
             state = CASE WHEN state = 'dormant' THEN 'active' ELSE state END
       WHERE id = ?`
    ).run(90 * 24 * 3600, now, id)
  } catch {
    // best-effort
  }
}

/**
 * 取某项目内待巩固的高价值情景（机制 5 睡眠巩固的原料）。
 * 条件：未巩固、active、salience×实时强度高。按该综合分降序。best-effort。
 */
export function consolidationCandidates(projectId: string, limit = 12): EpisodicHit[] {
  try {
    const d = getDb()
    const now = Date.now()
    const rows = d
      .prepare(
        `SELECT id, scope, project_id AS projectId, session_id AS sessionId, kind, content,
                summary, anchor_file AS anchorFile, anchor_symbol AS anchorSymbol,
                salience, strength, last_access AS lastAccess, tau
         FROM episodic
         WHERE project_id = ? AND consolidated = 0 AND state = 'active'
           AND (activations >= 2 OR salience >= 0.85)
         ORDER BY salience DESC, strength DESC
         LIMIT ?`
      )
      .all(projectId, limit * 2) as Array<{
      id: string; scope: EpisodicScope; projectId: string | null; sessionId: string | null
      kind: string; content: string; summary: string | null; anchorFile: string | null
      anchorSymbol: string | null; salience: number; strength: number; lastAccess: number; tau: number
    }>
    return rows
      .map((r) => {
        const live = liveStrength(r.strength, r.lastAccess, r.tau, now)
        return {
          id: r.id, scope: r.scope, projectId: r.projectId, sessionId: r.sessionId, kind: r.kind,
          content: r.content, summary: r.summary, anchorFile: r.anchorFile, anchorSymbol: r.anchorSymbol,
          salience: r.salience, strength: live, score: live * (0.5 + r.salience)
        } as EpisodicHit
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  } catch {
    return []
  }
}

/** 标记一组情景已巩固：consolidated=1，并加速衰减（τ 砍半，海马副本弱化）。best-effort。 */
export function markConsolidated(ids: string[]): void {
  if (ids.length === 0) return
  try {
    const d = getDb()
    const stmt = d.prepare(`UPDATE episodic SET consolidated = 1, tau = tau * 0.5 WHERE id = ?`)
    const tx = (d as any).transaction(() => {
      for (const id of ids) stmt.run(id)
    })
    tx()
  } catch {
    // best-effort
  }
}

/**
 * 衰减扫描（机制 4）：把实时强度跌破阈值的记忆降级状态。
 * active→dormant(<0.1)、dormant→archived(<0.02)。归档不删除，仍可深检索。
 * 建议启动时与空闲时各跑一次。返回流转条数。best-effort。
 */
export function sweepDecay(): { toDormant: number; toArchived: number } {
  try {
    const d = getDb()
    const now = Date.now()
    // 用 SQL 内联计算实时强度：strength * exp(-(now-last_access)/1000/tau)。
    const liveExpr = `(strength * exp(- ((? - last_access) / 1000.0) / MAX(1, tau)))`
    const toArchived = (d.prepare(
      `UPDATE episodic SET state = 'archived'
       WHERE state = 'dormant' AND ${liveExpr} < 0.02`
    ).run(now) as { changes: number }).changes
    const toDormant = (d.prepare(
      `UPDATE episodic SET state = 'dormant'
       WHERE state = 'active' AND ${liveExpr} < 0.1`
    ).run(now) as { changes: number }).changes
    return { toDormant, toArchived }
  } catch {
    return { toDormant: 0, toArchived: 0 }
  }
}

/**
 * 启动/空闲时的安全衰减扫描：仅当 episodic.db 已存在时才执行，避免为未使用记忆的用户
 * 凭空创建空库。best-effort，不抛。
 */
export function sweepDecayIfExists(): { toDormant: number; toArchived: number } {
  try {
    if (!existsSync(dbPath())) return { toDormant: 0, toArchived: 0 }
  } catch {
    return { toDormant: 0, toArchived: 0 }
  }
  return sweepDecay()
}

/**
 * 冲突检测：找出与给定向量高度相似（sim ≥ threshold）、同 scope/project 的既有记忆 id。
 * 用于写入新记忆时把"讲同一件事的旧版本"标记为被取代。排除 excludeId 自身。best-effort。
 */
export function findSimilarForConflict(params: {
  queryVec: number[]
  scope: EpisodicScope
  projectId: string | null
  excludeId: string
  threshold?: number
  probe?: number
}): string[] {
  try {
    const d = getDb()
    const threshold = params.threshold ?? 0.9
    const probe = params.probe ?? 10
    const rows = d
      .prepare(
        `SELECT e.id AS id, e.scope AS scope, e.project_id AS projectId, v.distance AS distance
         FROM vec_episodic v
         JOIN episodic e ON e.id = v.epi_id
         WHERE v.embedding MATCH ? AND k = ?
           AND e.superseded_by IS NULL AND e.state != 'archived'`
      )
      .all(toBlob(params.queryVec), probe) as Array<{
      id: string; scope: string; projectId: string | null; distance: number
    }>
    return rows
      .filter(
        (r) =>
          r.id !== params.excludeId &&
          r.scope === params.scope &&
          (r.projectId ?? null) === (params.projectId ?? null) &&
          1 - r.distance / 2 >= threshold
      )
      .map((r) => r.id)
  } catch {
    return []
  }
}

/** 把一组旧记忆标记为被 newId 取代（superseded_by 指向新记忆）。召回会自动过滤掉它们。best-effort。 */
export function markSuperseded(oldIds: string[], newId: string): void {
  if (oldIds.length === 0) return
  try {
    const d = getDb()
    const stmt = d.prepare(`UPDATE episodic SET superseded_by = ? WHERE id = ?`)
    const tx = (d as any).transaction(() => {
      for (const id of oldIds) stmt.run(newId, id)
    })
    tx()
  } catch {
    // best-effort
  }
}

export interface EpisodeView {
  id: string
  scope: EpisodicScope
  projectId: string | null
  sessionId: string | null
  kind: string
  content: string
  summary: string | null
  anchorFile: string | null
  salience: number
  activations: number
  strength: number
  state: string
  consolidated: number
  createdAt: number
  lastAccess: number
}

export interface MemoryGraph {
  episodes: EpisodeView[]
  edges: Array<{ src: string; dst: string; weight: number }>
}

/**
 * 列出记忆库用于可视化：返回（可按项目筛选的）记忆条目（含实时强度）+ 联想边。
 * 默认排除已 supersede 的；包含所有 state（active/dormant/archived）以便观察衰减。best-effort。
 */
export function listMemoryGraph(params: { projectId?: string | null; limit?: number }): MemoryGraph {
  try {
    const d = getDb()
    const now = Date.now()
    const limit = Math.max(1, Math.min(2000, params.limit ?? 500))
    const where = params.projectId
      ? `WHERE superseded_by IS NULL AND (scope = 'global' OR project_id = ?)`
      : `WHERE superseded_by IS NULL`
    const args = params.projectId ? [params.projectId, limit] : [limit]
    const rows = d
      .prepare(
        `SELECT id, scope, project_id AS projectId, session_id AS sessionId, kind, content, summary,
                anchor_file AS anchorFile, salience, activations, strength, tau, state, consolidated,
                created_at AS createdAt, last_access AS lastAccess
         FROM episodic ${where}
         ORDER BY created_at DESC LIMIT ?`
      )
      .all(...args) as Array<EpisodeView & { tau: number }>
    const episodes: EpisodeView[] = rows.map((r) => ({
      id: r.id, scope: r.scope, projectId: r.projectId, sessionId: r.sessionId, kind: r.kind,
      content: r.content, summary: r.summary, anchorFile: r.anchorFile, salience: r.salience,
      activations: r.activations, strength: liveStrength(r.strength, r.lastAccess, r.tau, now),
      state: r.state, consolidated: r.consolidated, createdAt: r.createdAt, lastAccess: r.lastAccess
    }))
    const idSet = new Set(episodes.map((e) => e.id))
    const allEdges = d
      .prepare(`SELECT src, dst, weight FROM episodic_edges`)
      .all() as Array<{ src: string; dst: string; weight: number }>
    // 只保留两端都在结果集内、且 src<dst 的边（无向去重）。
    const edges = allEdges.filter((e) => idSet.has(e.src) && idSet.has(e.dst) && e.src < e.dst)
    return { episodes, edges }
  } catch {
    return { episodes: [], edges: [] }
  }
}

/**
 * 删除一条记忆：同时清理向量、联想边、以及指向它的 superseded_by。best-effort 事务。
 */
export function deleteEpisode(id: string): { ok: boolean } {
  try {
    const d = getDb()
    d.exec('BEGIN')
    try {
      d.prepare(`DELETE FROM vec_episodic WHERE epi_id = ?`).run(id)
      d.prepare(`DELETE FROM episodic_edges WHERE src = ? OR dst = ?`).run(id, id)
      d.prepare(`UPDATE episodic SET superseded_by = NULL WHERE superseded_by = ?`).run(id)
      d.prepare(`DELETE FROM episodic WHERE id = ?`).run(id)
      d.exec('COMMIT')
    } catch (e) {
      d.exec('ROLLBACK')
      throw e
    }
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

/**
 * 编辑一条记忆的正文/摘要/类型/显著度。不重算向量（正文语义微调场景足够）；
 * 若需要按新正文重建检索向量，可在调用方另行 re-embed。best-effort。
 */
export function updateEpisode(params: {
  id: string
  content?: string
  summary?: string | null
  kind?: string
  salience?: number
}): { ok: boolean } {
  try {
    const d = getDb()
    const sets: string[] = []
    const args: unknown[] = []
    if (typeof params.content === 'string') {
      sets.push('content = ?')
      args.push(params.content)
    }
    if (params.summary !== undefined) {
      sets.push('summary = ?')
      args.push(params.summary)
    }
    if (typeof params.kind === 'string') {
      sets.push('kind = ?')
      args.push(params.kind)
    }
    if (typeof params.salience === 'number') {
      sets.push('salience = ?')
      args.push(Math.max(0, Math.min(1, params.salience)))
    }
    if (sets.length === 0) return { ok: true }
    args.push(params.id)
    d.prepare(`UPDATE episodic SET ${sets.join(', ')} WHERE id = ?`).run(...args)
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

/**
 * 用新向量替换某条记忆的检索向量（编辑正文后 re-embed 用）。best-effort。
 */
export function updateEpisodeVector(id: string, vector: number[]): { ok: boolean } {
  try {
    if (!vector || vector.length === 0) return { ok: false }
    const d = getDb()
    const tx = (d as any).transaction(() => {
      d.prepare(`DELETE FROM vec_episodic WHERE epi_id = ?`).run(id)
      d.prepare(`INSERT INTO vec_episodic (epi_id, embedding) VALUES (?, ?)`).run(id, toBlob(vector))
    })
    tx()
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

export function closeEpisodicStore(): void {
  if (db) {
    try {
      db.close()
    } catch {
      // ignore
    }
    db = null
  }
}
