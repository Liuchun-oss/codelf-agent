import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { copyFileSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { REDTEAM_DDL, REDTEAM_POC_DDL } from './schema'
import { BUILTIN_SCORE_POINTS, type BuiltinScorePoint } from './scorePoints.data'
import { REDTEAM_ROLE_PROMPTS } from './prompts.data'
import { evaluateScoreBoard, tunnelIsLegit, type ScoreBoard } from './scoreRules'

/**
 * 红队演练资产库（SQLite）。
 *
 * 目录布局：
 *   <userData>/redteam/
 *     current                         当前靶标 id（纯文本指针）
 *     knowledge.db                    全局 POC 知识库（跨靶标共享）
 *     pocs/                           知识库正文落盘
 *     engagements/<id>/
 *       engagement.yaml              靶标元信息
 *       assets.db                    该靶标的库（资产/漏洞/得分/证据…）
 *       agents/<code>.md             该靶标的角色提示词
 *       shots/                       证据截图
 *       attack-files/<target>/       攻击文件
 *
 * 为什么必须按靶标分库：不同靶标的资产、漏洞、得分互不可见。共用一个库会让两次
 * 演练的数据混在一起，得分上限/去重口径全部失真，报告也就不可信了。
 */

interface SqliteStatement {
  run(...args: unknown[]): unknown
  get(...args: unknown[]): unknown
  all(...args: unknown[]): unknown[]
}
interface SqliteDb {
  prepare(sql: string): SqliteStatement
  exec(sql: string): void
  pragma(s: string): unknown
  close(): void
}

let loadError: string | null = null
const dbHandles = new Map<string, SqliteDb>()
let kbHandle: SqliteDb | null = null
let customOpener: ((file: string) => SqliteDb) | null = null

/** 仅供测试：注入兼容驱动（如 node:sqlite），让 store 能在 Electron 外被验证。 */
export function setRedteamDbOpenerForTests(opener: ((file: string) => SqliteDb) | null): void {
  customOpener = opener
  probeCache = null
}

export function redteamRoot(): string {
  const dir = join(app.getPath('userData'), 'redteam')
  mkdirSync(dir, { recursive: true })
  return dir
}

function engagementsDir(): string {
  const dir = join(redteamRoot(), 'engagements')
  mkdirSync(dir, { recursive: true })
  return dir
}

function currentPath(): string {
  return join(redteamRoot(), 'current')
}

export function engagementDir(id: string): string {
  return join(engagementsDir(), id)
}

function dbPathOf(id: string): string {
  return join(engagementDir(id), 'assets.db')
}

export function knowledgePath(): string {
  return join(redteamRoot(), 'knowledge.db')
}

export function pocsDir(): string {
  const dir = join(redteamRoot(), 'pocs')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function shotsDirOf(id: string): string {
  const dir = join(engagementDir(id), 'shots')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function attackFilesDirOf(id: string): string {
  const dir = join(engagementDir(id), 'attack-files')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function agentsDirOf(id: string): string {
  const dir = join(engagementDir(id), 'agents')
  mkdirSync(dir, { recursive: true })
  return dir
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

function openDatabase(file: string): SqliteDb {
  // 仅供测试：用 node:sqlite 之类兼容驱动替换（better-sqlite3 是按 Electron ABI 编的，
  // 在纯 node 下加载不了）。生产路径永远走下面的 require。
  if (customOpener) return customOpener(file)
  const nativeBinding = betterSqliteNativePath()
  const modRoot = join(nodeModulesRoot(), 'better-sqlite3')
  /* eslint-disable @typescript-eslint/no-require-imports -- 原生模块必须运行时按需 require，
     与 electron/services/knowledge/store.ts 同一写法 */
  const Database = (
    existsSync(join(modRoot, 'package.json')) ? require(modRoot) : require('better-sqlite3')
  ) as new (path: string, opts?: { nativeBinding?: string }) => SqliteDb
  /* eslint-enable @typescript-eslint/no-require-imports */
  return nativeBinding ? new Database(file, { nativeBinding }) : new Database(file)
}

/**
 * 播种内置得分点。用 code 作幂等键，只补缺不覆盖 ——
 * 用户停用过的点（enabled=0）在重启后不能被重新写入重新启用。
 */
function seedScorePoints(instance: SqliteDb): void {
  const now = new Date().toISOString()
  const exists = instance.prepare('SELECT code FROM score_point WHERE code = ?')
  const insert = instance.prepare(
    `INSERT INTO score_point
      (code, name, category, points, description, enabled, sort_order,
       src, rule, tier, cap, dedup_scope, legacy, builtin, created_at, updated_at)
     VALUES (?,?,?,?,?,1,?,?,?,?,?,?,0,1,?,?)`
  )
  for (let i = 0; i < BUILTIN_SCORE_POINTS.length; i += 1) {
    const p = BUILTIN_SCORE_POINTS[i]
    if (exists.get(p.code)) continue
    insert.run(p.code, p.name, p.category, p.points, p.description, i, p.src, p.rule, p.tier, p.cap, p.dedup_scope, now, now)
  }
}

function initSchema(instance: SqliteDb): void {
  instance.pragma('journal_mode = WAL')
  instance.exec(REDTEAM_DDL)
  seedScorePoints(instance)
}

/** 打开（必要时创建）某个靶标的库。 */
function dbOf(id: string): SqliteDb {
  const cached = dbHandles.get(id)
  if (cached) return cached
  const file = dbPathOf(id)
  if (!existsSync(file)) {
    throw new Error(`靶标不存在或未初始化：${id}（先调用 redteam_engagement_open）`)
  }
  const instance = openDatabase(file)
  initSchema(instance)
  dbHandles.set(id, instance)
  return instance
}

/** 全局 POC 知识库。与靶标库分开，跨靶标共享。 */
function kbDb(): SqliteDb {
  if (kbHandle) return kbHandle
  mkdirSync(pocsDir(), { recursive: true })
  const instance = openDatabase(knowledgePath())
  instance.pragma('journal_mode = WAL')
  instance.exec(REDTEAM_POC_DDL)
  kbHandle = instance
  return instance
}

/** 探测能否用库（供注册工具时决定是否暴露红队工具）。结果缓存，避免每轮都开一次内存库。 */
let probeCache: { ok: boolean; error?: string } | null = null

export function probeRedteamStore(): { ok: boolean; error?: string } {
  if (probeCache) return probeCache
  try {
    const probe = openDatabase(':memory:')
    probe.exec('CREATE TABLE __probe (a INTEGER)')
    probe.close()
    redteamRoot()
    probeCache = { ok: true }
    return probeCache
  } catch (e) {
    loadError =
      '红队资产库：无法打开 SQLite（better-sqlite3 原生模块缺失或未按 Electron ABI 编译）。' +
      (app.isPackaged ? '安装包内原生组件缺失，请重新安装。' : '请先执行 npm run rebuild:native。') +
      '原始错误：' +
      (e instanceof Error ? e.message : String(e))
    probeCache = { ok: false, error: loadError }
    return probeCache
  }
}

export function resetRedteamStoreForTests(): void {
  for (const h of dbHandles.values()) {
    try {
      h.close()
    } catch {
      /* 忽略 */
    }
  }
  dbHandles.clear()
  try {
    kbHandle?.close()
  } catch {
    /* 忽略 */
  }
  kbHandle = null
  loadError = null
  probeCache = null
}

// ---------------------------------------------------------------- 靶标生命周期

export interface RedteamEngagement {
  id: string
  name: string
  scope?: string
  createdAt: string
  dbPath: string
}

const META_FILE = 'engagement.yaml'

function writeMeta(id: string, meta: { name: string; scope?: string; createdAt: string }): void {
  const lines = [
    `name: ${meta.name}`,
    meta.scope ? `scope: ${meta.scope}` : 'scope:',
    `createdAt: ${meta.createdAt}`
  ]
  writeFileSync(join(engagementDir(id), META_FILE), lines.join('\n') + '\n', 'utf-8')
}

function readMeta(id: string): { name: string; scope?: string; createdAt: string } {
  const file = join(engagementDir(id), META_FILE)
  const fallback = { name: id, createdAt: new Date(0).toISOString() }
  if (!existsSync(file)) return fallback
  try {
    const raw = readFileSync(file, 'utf-8')
    const get = (k: string): string | undefined => {
      const m = new RegExp('^' + k + ':\\s*(.*)$', 'm').exec(raw)
      const v = m?.[1]?.trim()
      return v ? v : undefined
    }
    return {
      name: get('name') ?? id,
      scope: get('scope'),
      createdAt: get('createdAt') ?? fallback.createdAt
    }
  } catch {
    return fallback
  }
}

export function listEngagements(): RedteamEngagement[] {
  const root = engagementsDir()
  let entries: string[] = []
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => existsSync(dbPathOf(name)))
  } catch {
    return []
  }
  const out = entries.map((id) => {
    const meta = readMeta(id)
    return { id, name: meta.name, scope: meta.scope, createdAt: meta.createdAt, dbPath: dbPathOf(id) }
  })
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  return out
}

function slugify(name: string): string {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-|-$/g, '')
  return base || 'engagement-' + Date.now().toString(36)
}

/** 开靶：不存在就建（建库 + 写 meta），已存在就复用并切为当前靶标。 */
export function openEngagement(name: string, scope?: string): RedteamEngagement {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('靶标名称不能为空')
  // 已存在的（按 id 或 name 匹配）直接复用
  const existing = listEngagements().find(
    (e) => e.id === slugify(trimmed) || e.name === trimmed
  )
  if (existing) {
    if (scope !== undefined && scope !== existing.scope) {
      writeMeta(existing.id, { name: existing.name, scope, createdAt: existing.createdAt })
    }
    setActiveEngagement(existing.id)
    return { ...existing, scope: scope ?? existing.scope }
  }

  const id = slugify(trimmed)
  mkdirSync(engagementDir(id), { recursive: true })
  const instance = openDatabase(dbPathOf(id))
  initSchema(instance)
  dbHandles.set(id, instance)
  const createdAt = new Date().toISOString()
  writeMeta(id, { name: trimmed, scope, createdAt })
  setActiveEngagement(id)
  return { id, name: trimmed, scope, createdAt, dbPath: dbPathOf(id) }
}

export function setActiveEngagement(id: string | null): boolean {
  if (id === null) {
    try {
      rmSync(currentPath(), { force: true })
    } catch {
      /* 忽略 */
    }
    return true
  }
  if (!existsSync(dbPathOf(id))) return false
  writeFileSync(currentPath(), id, 'utf-8')
  return true
}

export function activeEngagementId(): string | null {
  try {
    const raw = readFileSync(currentPath(), 'utf-8').trim()
    if (raw && existsSync(dbPathOf(raw))) return raw
  } catch {
    /* 无指针时回退 */
  }
  const list = listEngagements()
  return list.length ? list[0].id : null
}

export function currentEngagement(): RedteamEngagement | null {
  const id = activeEngagementId()
  if (!id) return null
  const meta = readMeta(id)
  return { id, name: meta.name, scope: meta.scope, createdAt: meta.createdAt, dbPath: dbPathOf(id) }
}

/** 数据类操作统一从这里取靶标；没有绑定就明确报错，而不是写进一个「默认库」。 */
export function requireEngagementId(explicit?: string): string {
  const target = (explicit || '').trim()
  if (target) {
    const hit = listEngagements().find((e) => e.id === target || e.name === target)
    if (!hit) throw new Error(`靶标不存在：${target}。先调用 redteam_engagement_open 创建。`)
    return hit.id
  }
  const id = activeEngagementId()
  if (!id) {
    throw new Error(
      '当前会话没有绑定靶标。先调用 redteam_engagement_open 指定目标单位名称与授权范围后再开工。'
    )
  }
  return id
}

// ---------------------------------------------------------------- 低层访问

function all<T = Record<string, unknown>>(sql: string, ...args: unknown[]): T[] {
  return dbOf(requireEngagementId()).prepare(sql).all(...args) as T[]
}

function get<T = Record<string, unknown>>(sql: string, ...args: unknown[]): T | undefined {
  return dbOf(requireEngagementId()).prepare(sql).get(...args) as T | undefined
}

function run(sql: string, ...args: unknown[]): void {
  dbOf(requireEngagementId()).prepare(sql).run(...args)
}

function lastId(): number {
  const row = get<{ id: number }>('SELECT last_insert_rowid() AS id')
  return Number(row?.id ?? 0)
}

function nowISO(): string {
  return new Date().toISOString()
}

function sha256(file: string): string {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------- 资产

function deriveSegment(ip: string, given?: string): string {
  const explicit = (given || '').trim()
  if (explicit) return explicit
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(ip.trim())
  if (m) return `${m[1]}.${m[2]}.${m[3]}.0/24`
  return ip.trim()
}

function ipToInt(ip: string): number | null {
  const parts = ip.trim().split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    const v = Number(p)
    if (!Number.isInteger(v) || v < 0 || v > 255) return null
    n = n * 256 + v
  }
  return n
}

export interface AssetRow {
  id: number
  ip: string
  segment_cidr: string
  state: string | null
  primary_name: string | null
  test_status: string | null
  test_notes: string | null
  test_surface: string | null
  priority: string | null
  potential: string | null
  assess_reason: string | null
  discovered_at: string | null
  last_seen: string | null
}

export interface AssetPortInput {
  port: number
  proto?: string
  state?: string
  banner?: string
  url?: string
  title?: string
  service?: string
  product?: string
  version?: string
  fingerprints?: Array<{
    category?: string
    vendor?: string
    product?: string
    version?: string
    evidence?: string
    confidence?: number
  }>
}

export interface AssetUpsertInput {
  ip: string
  segment?: string
  state?: string
  primaryName?: string
  confidence?: number
  provenance?: string
  tool?: string
  names?: Array<string | { name: string; kind?: string; provenance?: string }>
  ports?: AssetPortInput[]
  discoveredAt?: string
  firstSeen?: string
}

/** 资产落库（幂等）：同一 (网段, IP) 重复写只更新 last_seen 与本次给出的字段。 */
export function upsertAsset(input: AssetUpsertInput): { asset: AssetRow; created: boolean } {
  const ip = input.ip.trim()
  if (!ip) throw new Error('asset.ip 不能为空')
  const segment = deriveSegment(ip, input.segment)
  const now = nowISO()
  const existing = get<AssetRow>('SELECT * FROM asset WHERE segment_cidr = ? AND ip = ?', segment, ip)

  let assetId: number
  let created = false
  if (existing) {
    assetId = existing.id
    run(
      `UPDATE asset SET last_seen = ?,
        state = COALESCE(?, state),
        primary_name = COALESCE(?, primary_name),
        confidence = COALESCE(?, confidence)
       WHERE id = ?`,
      now,
      input.state ?? null,
      input.primaryName ?? null,
      input.confidence ?? null,
      assetId
    )
  } else {
    run(
      `INSERT INTO asset (segment_cidr, ip, ip_int, state, primary_name, confidence,
        first_seen, last_seen, discovered_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      segment,
      ip,
      ipToInt(ip),
      input.state ?? 'unknown',
      input.primaryName ?? null,
      input.confidence ?? null,
      input.firstSeen ?? now,
      now,
      input.discoveredAt ?? now
    )
    assetId = lastId()
    created = true
  }

  for (const raw of input.names ?? []) {
    const n = typeof raw === 'string' ? { name: raw } : raw
    const name = (n.name ?? '').trim()
    if (!name) continue
    run(
      `INSERT OR IGNORE INTO asset_name (asset_id, name, kind, provenance, tool, first_seen, last_seen)
       VALUES (?,?,?,?,?,?,?)`,
      assetId,
      name,
      n.kind ?? 'domain',
      n.provenance ?? input.provenance ?? null,
      input.tool ?? null,
      now,
      now
    )
  }

  for (const p of input.ports ?? []) {
    const portNum = Number(p.port)
    if (!Number.isInteger(portNum) || portNum <= 0 || portNum > 65535) continue
    const proto = p.proto || 'tcp'
    run(
      `INSERT OR IGNORE INTO port (asset_id, proto, port, state, provenance, tool, banner, url, title, first_seen, last_seen)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      assetId,
      proto,
      portNum,
      p.state ?? 'open',
      input.provenance ?? null,
      input.tool ?? null,
      p.banner ?? null,
      p.url ?? null,
      p.title ?? null,
      now,
      now
    )
    run(
      `UPDATE port SET last_seen = ?, state = COALESCE(?, state),
        banner = COALESCE(?, banner), url = COALESCE(?, url), title = COALESCE(?, title)
       WHERE asset_id = ? AND proto = ? AND port = ?`,
      now,
      p.state ?? null,
      p.banner ?? null,
      p.url ?? null,
      p.title ?? null,
      assetId,
      proto,
      portNum
    )
    const portRow = get<{ id: number }>(
      'SELECT id FROM port WHERE asset_id = ? AND proto = ? AND port = ?',
      assetId,
      proto,
      portNum
    )
    if (!portRow) continue
    if (p.service || p.product || p.version) {
      const hasSvc = get('SELECT id FROM service WHERE port_id = ? AND name IS ?', portRow.id, p.service ?? null)
      if (hasSvc) {
        run(
          'UPDATE service SET last_seen = ?, product = COALESCE(?, product), version = COALESCE(?, version) WHERE port_id = ? AND name IS ?',
          now,
          p.product ?? null,
          p.version ?? null,
          portRow.id,
          p.service ?? null
        )
      } else {
        run(
          `INSERT INTO service (port_id, name, product, version, provenance, tool, first_seen, last_seen)
           VALUES (?,?,?,?,?,?,?,?)`,
          portRow.id,
          p.service ?? null,
          p.product ?? null,
          p.version ?? null,
          input.provenance ?? null,
          input.tool ?? null,
          now,
          now
        )
      }
    }
    for (const fp of p.fingerprints ?? []) {
      run(
        `INSERT INTO fingerprint (asset_id, port_id, category, vendor, product, version,
          evidence, confidence, provenance, tool, first_seen, last_seen)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        assetId,
        portRow.id,
        fp.category ?? null,
        fp.vendor ?? null,
        fp.product ?? null,
        fp.version ?? null,
        fp.evidence ?? null,
        fp.confidence ?? null,
        input.provenance ?? null,
        input.tool ?? null,
        now,
        now
      )
    }
  }

  if (input.provenance) {
    run(
      `INSERT INTO observation (entity_kind, entity_id, attr, value, provenance, tool, collected_at)
       VALUES ('asset', ?, 'discovered', ?, ?, ?, ?)`,
      assetId,
      ip,
      input.provenance,
      input.tool ?? null,
      now
    )
  }

  const asset = get<AssetRow>('SELECT * FROM asset WHERE id = ?', assetId)
  if (!asset) throw new Error('资产读取失败')
  return { asset, created }
}

export interface AssetQueryInput {
  ip?: string
  segment?: string
  state?: string
  primaryName?: string
  testStatus?: string
  priority?: string
  port?: number
  service?: string
  fingerprint?: string
  keyword?: string
  limit?: number
}

export function queryAssets(input: AssetQueryInput): AssetRow[] {
  const where: string[] = []
  const args: unknown[] = []
  if (input.ip?.trim()) {
    where.push('ip LIKE ?')
    args.push('%' + input.ip.trim() + '%')
  }
  if (input.segment?.trim()) {
    where.push('segment_cidr = ?')
    args.push(input.segment.trim())
  }
  if (input.state?.trim()) {
    where.push('state = ?')
    args.push(input.state.trim())
  }
  if (input.primaryName?.trim()) {
    where.push('primary_name LIKE ?')
    args.push('%' + input.primaryName.trim() + '%')
  }
  if (input.testStatus?.trim()) {
    where.push('test_status = ?')
    args.push(input.testStatus.trim())
  }
  if (input.priority?.trim()) {
    where.push('priority = ?')
    args.push(input.priority.trim())
  }
  if (input.port != null && Number.isFinite(Number(input.port))) {
    where.push('id IN (SELECT asset_id FROM port WHERE port = ?)')
    args.push(Number(input.port))
  }
  if (input.service?.trim()) {
    where.push(
      'id IN (SELECT p.asset_id FROM port p JOIN service s ON s.port_id = p.id WHERE s.name LIKE ? OR s.product LIKE ?)'
    )
    args.push('%' + input.service.trim() + '%', '%' + input.service.trim() + '%')
  }
  if (input.fingerprint?.trim()) {
    where.push(
      'id IN (SELECT asset_id FROM fingerprint WHERE product LIKE ? OR vendor LIKE ? OR category LIKE ?)'
    )
    const k = '%' + input.fingerprint.trim() + '%'
    args.push(k, k, k)
  }
  if (input.keyword?.trim()) {
    where.push('(ip LIKE ? OR primary_name LIKE ?)')
    const k = '%' + input.keyword.trim() + '%'
    args.push(k, k)
  }
  const limit = Math.min(Math.max(Number(input.limit) || 50, 1), 500)
  return all<AssetRow>(
    'SELECT * FROM asset' +
      (where.length ? ' WHERE ' + where.join(' AND ') : '') +
      ' ORDER BY id DESC LIMIT ?',
    ...args,
    limit
  )
}

/** 单个资产完整详情：端口+服务+指纹+域名+观测时间线+关系边。 */
export function getAssetDetail(id: number): Record<string, unknown> | null {
  const asset = get<AssetRow>('SELECT * FROM asset WHERE id = ?', id)
  if (!asset) return null
  const ports = all<{ id: number; port: number; proto: string; state: string; url: string | null; title: string | null; banner: string | null }>(
    'SELECT * FROM port WHERE asset_id = ? ORDER BY port',
    id
  )
  const services = all('SELECT * FROM service WHERE port_id IN (SELECT id FROM port WHERE asset_id = ?)', id)
  const fingerprints = all('SELECT * FROM fingerprint WHERE asset_id = ?', id)
  const names = all('SELECT * FROM asset_name WHERE asset_id = ?', id)
  const observations = all(
    'SELECT * FROM observation WHERE entity_kind = ? AND entity_id = ? ORDER BY collected_at',
    'asset',
    id
  )
  const edges = all(
    'SELECT * FROM edge WHERE (src_kind = ? AND src_id = ?) OR (dst_kind = ? AND dst_id = ?)',
    'asset',
    String(id),
    'asset',
    String(id)
  )
  return { asset, ports, services, fingerprints, names, observations, edges }
}

export function assetStats(): Record<string, unknown> {
  const total = get<{ n: number }>('SELECT COUNT(*) AS n FROM asset')?.n ?? 0
  const byState = all<{ state: string; n: number }>(
    "SELECT COALESCE(state, 'unknown') AS state, COUNT(*) AS n FROM asset GROUP BY state ORDER BY n DESC"
  )
  const byTest = all<{ test_status: string; n: number }>(
    "SELECT COALESCE(test_status, 'untested') AS test_status, COUNT(*) AS n FROM asset GROUP BY test_status ORDER BY n DESC"
  )
  const segments = all<{ segment_cidr: string; n: number; alive: number }>(
    `SELECT segment_cidr, COUNT(*) AS n,
       SUM(CASE WHEN state = 'live' OR state = 'alive' THEN 1 ELSE 0 END) AS alive
     FROM asset GROUP BY segment_cidr ORDER BY n DESC LIMIT 50`
  )
  const ports = get<{ n: number }>("SELECT COUNT(*) AS n FROM port WHERE state = 'open'")?.n ?? 0
  const services = get<{ n: number }>('SELECT COUNT(*) AS n FROM service')?.n ?? 0
  const fingerprints = get<{ n: number }>('SELECT COUNT(*) AS n FROM fingerprint')?.n ?? 0
  const names = get<{ n: number }>('SELECT COUNT(*) AS n FROM asset_name')?.n ?? 0
  const passive =
    get<{ n: number }>("SELECT COUNT(*) AS n FROM observation WHERE provenance = 'passive'")?.n ?? 0
  const active =
    get<{ n: number }>("SELECT COUNT(*) AS n FROM observation WHERE provenance = 'active'")?.n ?? 0
  return {
    total,
    segments: segments.length,
    openPorts: ports,
    services,
    fingerprints,
    names,
    passiveSignals: passive,
    activeSignals: active,
    byState,
    byTest,
    segmentDetail: segments
  }
}

export function assessAsset(
  id: number,
  priority: string,
  potential: string,
  reason: string,
  by?: string
): boolean {
  if (!get('SELECT id FROM asset WHERE id = ?', id)) return false
  run(
    'UPDATE asset SET priority = ?, potential = ?, assess_reason = ?, assessed_at = ?, assessed_by = ? WHERE id = ?',
    priority,
    potential,
    reason,
    nowISO(),
    by ?? null,
    id
  )
  return true
}

export function markAssetTest(
  id: number,
  status: string,
  notes?: string,
  surface?: string,
  by?: string
): boolean {
  if (!get('SELECT id FROM asset WHERE id = ?', id)) return false
  run(
    `UPDATE asset SET test_status = ?, test_notes = COALESCE(?, test_notes),
      test_surface = COALESCE(?, test_surface), test_updated_at = ?, test_updated_by = ?
     WHERE id = ?`,
    status,
    notes ?? null,
    surface ?? null,
    nowISO(),
    by ?? null,
    id
  )
  return true
}

export function linkAssets(input: {
  srcKind: string
  srcId: string
  dstKind: string
  dstId: string
  relation: string
  confidence?: number
}): number {
  const now = nowISO()
  run(
    `INSERT INTO edge (src_kind, src_id, dst_kind, dst_id, relation, confidence, first_seen, last_seen)
     VALUES (?,?,?,?,?,?,?,?)`,
    input.srcKind,
    input.srcId,
    input.dstKind,
    input.dstId,
    input.relation,
    input.confidence ?? null,
    now,
    now
  )
  return lastId()
}

/** 资产图谱：网段 → 资产 → 端口，含域名边。节点超限时按 C 段缩小。 */
export function assetGraph(cidr?: string, maxNodes = 300): Record<string, unknown> {
  const where = cidr?.trim() ? 'WHERE segment_cidr = ?' : ''
  const args = cidr?.trim() ? [cidr.trim()] : []
  const assets = all<AssetRow>(
    `SELECT * FROM asset ${where} ORDER BY segment_cidr, ip_int LIMIT ?`,
    ...args,
    Math.min(maxNodes, 2000)
  )
  const ids = assets.map((a) => a.id)
  const ports = ids.length
    ? all<{ asset_id: number; port: number; proto: string; url: string | null; title: string | null }>(
        `SELECT asset_id, port, proto, url, title FROM port WHERE asset_id IN (${ids.map(() => '?').join(',')}) ORDER BY port`,
        ...ids
      )
    : []
  const names = ids.length
    ? all<{ asset_id: number; name: string; kind: string }>(
        `SELECT asset_id, name, kind FROM asset_name WHERE asset_id IN (${ids.map(() => '?').join(',')})`,
        ...ids
      )
    : []
  const edges = all('SELECT * FROM edge LIMIT 2000')
  const segs = [...new Set(assets.map((a) => a.segment_cidr))]
  return {
    segments: segs.map((s) => ({ cidr: s, assets: assets.filter((a) => a.segment_cidr === s).length })),
    assets: assets.map((a) => ({
      id: a.id,
      ip: a.ip,
      segment: a.segment_cidr,
      state: a.state,
      name: a.primary_name,
      ports: ports.filter((p) => p.asset_id === a.id).map((p) => ({ port: p.port, proto: p.proto, url: p.url, title: p.title })),
      names: names.filter((n) => n.asset_id === a.id).map((n) => n.name)
    })),
    edges,
    truncated: assets.length >= Math.min(maxNodes, 2000)
  }
}

/** 按天聚合资产发现量。 */
export function assetTimeline(limit = 50): Record<string, unknown> {
  const days = all<{ day: string; n: number }>(
    "SELECT substr(COALESCE(discovered_at, first_seen, ''), 1, 10) AS day, COUNT(*) AS n FROM asset GROUP BY day ORDER BY day DESC LIMIT 60"
  )
  const recent = all<AssetRow>('SELECT * FROM asset ORDER BY id DESC LIMIT ?', Math.min(limit, 500))
  return { byDay: days.filter((d) => d.day), recent }
}

// ---------------------------------------------------------------- 漏洞

export function addVuln(input: {
  assetId?: number | null
  portId?: number | null
  cve?: string
  title: string
  severity?: string
  source?: string
  confidence?: number
  status?: string
  evidence?: string
  target?: string
  gained?: string
  agent?: string
}): number {
  // 带 cve 时按 (asset_id, cve, target) 幂等更新，避免重复落同一条
  if (input.cve?.trim() && input.target?.trim()) {
    const hit = get<{ id: number }>(
      'SELECT id FROM vuln WHERE asset_id IS ? AND cve = ? AND target = ?',
      input.assetId ?? null,
      input.cve.trim(),
      input.target.trim()
    )
    if (hit) {
      run(
        'UPDATE vuln SET severity = COALESCE(?, severity), evidence = COALESCE(?, evidence), gained = COALESCE(?, gained) WHERE id = ?',
        input.severity ?? null,
        input.evidence ?? null,
        input.gained ?? null,
        hit.id
      )
      return hit.id
    }
  }
  run(
    `INSERT INTO vuln (asset_id, port_id, cve, title, severity, source, confidence, status,
      evidence, target, found_by_agent, found_at, gained, agent)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    input.assetId ?? null,
    input.portId ?? null,
    input.cve ?? null,
    input.title,
    input.severity ?? null,
    input.source ?? null,
    input.confidence ?? null,
    input.status ?? 'candidate',
    input.evidence ?? null,
    input.target ?? null,
    input.agent ?? null,
    nowISO(),
    input.gained ?? null,
    input.agent ?? null
  )
  return lastId()
}

export function queryVulns(input: {
  assetId?: number
  segment?: string
  severity?: string
  status?: string
  cve?: string
  target?: string
  keyword?: string
  limit?: number
}): Record<string, unknown>[] {
  const where: string[] = []
  const args: unknown[] = []
  if (input.assetId != null) {
    where.push('asset_id = ?')
    args.push(input.assetId)
  }
  if (input.segment?.trim()) {
    where.push('asset_id IN (SELECT id FROM asset WHERE segment_cidr = ?)')
    args.push(input.segment.trim())
  }
  if (input.severity?.trim()) {
    where.push('severity = ?')
    args.push(input.severity.trim())
  }
  if (input.status?.trim()) {
    where.push('status = ?')
    args.push(input.status.trim())
  }
  if (input.cve?.trim()) {
    where.push('cve LIKE ?')
    args.push('%' + input.cve.trim() + '%')
  }
  if (input.target?.trim()) {
    where.push('target LIKE ?')
    args.push('%' + input.target.trim() + '%')
  }
  if (input.keyword?.trim()) {
    where.push('(title LIKE ? OR evidence LIKE ?)')
    const k = '%' + input.keyword.trim() + '%'
    args.push(k, k)
  }
  const limit = Math.min(Math.max(Number(input.limit) || 50, 1), 500)
  return all(
    'SELECT * FROM vuln' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY id DESC LIMIT ?',
    ...args,
    limit
  )
}

export function updateVuln(id: number, patch: Record<string, unknown>): boolean {
  if (!get('SELECT id FROM vuln WHERE id = ?', id)) return false
  const allowed = ['status', 'severity', 'evidence', 'gained', 'cve', 'title', 'confidence', 'target', 'source']
  const sets: string[] = []
  const args: unknown[] = []
  for (const key of allowed) {
    if (patch[key] === undefined) continue
    sets.push(`${key} = ?`)
    args.push(patch[key])
  }
  if (!sets.length) return true
  run(`UPDATE vuln SET ${sets.join(', ')} WHERE id = ?`, ...args, id)
  return true
}

// ---------------------------------------------------------------- 凭据 / 访问 / WebShell / 隧道

export function addCredential(input: {
  assetId?: number | null
  host?: string
  username?: string
  secretType?: string
  secretValue?: string
  secretRef?: string
  privilege?: string
  source?: string
  tool?: string
  note?: string
  agent?: string
}): number {
  run(
    `INSERT OR REPLACE INTO credential (asset_id, host, username, secret_type, secret_value, secret_ref,
      privilege, source, tool, note, found_by_agent, found_at, agent)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    input.assetId ?? null,
    input.host ?? null,
    input.username ?? '',
    input.secretType ?? 'password',
    input.secretValue ?? null,
    input.secretRef ?? null,
    input.privilege ?? null,
    input.source ?? null,
    input.tool ?? null,
    input.note ?? null,
    input.agent ?? null,
    nowISO(),
    input.agent ?? null
  )
  return lastId()
}

export function listCredentials(assetId?: number, host?: string, limit = 100): Record<string, unknown>[] {
  const where: string[] = []
  const args: unknown[] = []
  if (assetId != null) {
    where.push('asset_id = ?')
    args.push(assetId)
  }
  if (host?.trim()) {
    where.push('host LIKE ?')
    args.push('%' + host.trim() + '%')
  }
  return all(
    'SELECT * FROM credential' +
      (where.length ? ' WHERE ' + where.join(' AND ') : '') +
      ' ORDER BY id DESC LIMIT ?',
    ...args,
    Math.min(limit, 500)
  )
}

export function addAccess(input: {
  assetId?: number | null
  host?: string
  username?: string
  method?: string
  privilege?: string
  sessionRef?: string
  note?: string
  agent?: string
}): number {
  run(
    `INSERT INTO access_session (asset_id, host, username, method, privilege, session_ref, note, found_by_agent, obtained_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    input.assetId ?? null,
    input.host ?? null,
    input.username ?? null,
    input.method ?? null,
    input.privilege ?? null,
    input.sessionRef ?? null,
    input.note ?? null,
    input.agent ?? null,
    nowISO()
  )
  return lastId()
}

export function listAccess(host?: string, limit = 100): Record<string, unknown>[] {
  if (host?.trim()) {
    return all('SELECT * FROM access_session WHERE host LIKE ? ORDER BY id DESC LIMIT ?', '%' + host.trim() + '%', Math.min(limit, 500))
  }
  return all('SELECT * FROM access_session ORDER BY id DESC LIMIT ?', Math.min(limit, 500))
}

export function addWebshell(input: {
  assetId?: number | null
  url: string
  shellType?: string
  passKey?: string
  secretRef?: string
  privilege?: string
  status?: string
  note?: string
  agent?: string
}): number {
  const now = nowISO()
  run(
    `INSERT INTO webshell (asset_id, url, shell_type, pass_key, secret_ref, privilege, status,
      note, found_by_agent, created_at, updated_at, agent)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    input.assetId ?? null,
    input.url,
    input.shellType ?? null,
    input.passKey ?? null,
    input.secretRef ?? null,
    input.privilege ?? null,
    input.status ?? 'unknown',
    input.note ?? null,
    input.agent ?? null,
    now,
    now,
    input.agent ?? null
  )
  return lastId()
}

export function listWebshells(assetId?: number, limit = 100): Record<string, unknown>[] {
  if (assetId != null) {
    return all('SELECT * FROM webshell WHERE asset_id = ? ORDER BY id DESC LIMIT ?', assetId, Math.min(limit, 500))
  }
  return all('SELECT * FROM webshell ORDER BY id DESC LIMIT ?', Math.min(limit, 500))
}

export function updateWebshell(
  id: number,
  patch: { status?: string; note?: string; latencyMs?: number; privilege?: string }
): boolean {
  if (!get('SELECT id FROM webshell WHERE id = ?', id)) return false
  const sets = ['updated_at = ?']
  const args: unknown[] = [nowISO()]
  if (patch.status !== undefined) {
    sets.push('status = ?', 'last_check = ?')
    args.push(patch.status, nowISO())
  }
  if (patch.note !== undefined) {
    sets.push('check_note = ?')
    args.push(patch.note)
  }
  if (patch.latencyMs !== undefined) {
    sets.push('latency_ms = ?')
    args.push(patch.latencyMs)
  }
  if (patch.privilege !== undefined) {
    sets.push('privilege = ?')
    args.push(patch.privilege)
  }
  run(`UPDATE webshell SET ${sets.join(', ')} WHERE id = ?`, ...args, id)
  return true
}

export function addTunnel(input: {
  assetId?: number | null
  webshellId?: number | null
  kind?: string
  listen?: string
  entry?: string
  reach?: string
  entryKind?: string
  status?: string
  command?: string
  pid?: string
  note?: string
  agent?: string
}): { id: number; legit: boolean | null } {
  const now = nowISO()
  run(
    `INSERT INTO tunnel (asset_id, webshell_id, kind, listen, entry, reach, entry_kind,
      status, command, pid, note, found_by_agent, created_at, updated_at, agent)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    input.assetId ?? null,
    input.webshellId ?? null,
    input.kind ?? null,
    input.listen ?? null,
    input.entry ?? null,
    input.reach ?? null,
    input.entryKind ?? null,
    input.status ?? 'unknown',
    input.command ?? null,
    input.pid ?? null,
    input.note ?? null,
    input.agent ?? null,
    now,
    now,
    input.agent ?? null
  )
  return { id: lastId(), legit: tunnelIsLegit(input.entryKind) }
}

export function listTunnels(assetId?: number, limit = 100): Record<string, unknown>[] {
  const rows =
    assetId != null
      ? all('SELECT * FROM tunnel WHERE asset_id = ? ORDER BY id DESC LIMIT ?', assetId, Math.min(limit, 500))
      : all('SELECT * FROM tunnel ORDER BY id DESC LIMIT ?', Math.min(limit, 500))
  return rows.map((r) => ({ ...r, legit: tunnelIsLegit(r.entry_kind as string | null) }))
}

export function updateTunnel(
  id: number,
  patch: { status?: string; reach?: string; note?: string; latencyMs?: number; entryKind?: string; listen?: string }
): boolean {
  if (!get('SELECT id FROM tunnel WHERE id = ?', id)) return false
  const sets = ['updated_at = ?']
  const args: unknown[] = [nowISO()]
  if (patch.status !== undefined) {
    sets.push('status = ?', 'last_check = ?')
    args.push(patch.status, nowISO())
  }
  if (patch.reach !== undefined) {
    sets.push('reach = ?')
    args.push(patch.reach)
  }
  if (patch.note !== undefined) {
    sets.push('check_note = ?')
    args.push(patch.note)
  }
  if (patch.latencyMs !== undefined) {
    sets.push('latency_ms = ?')
    args.push(patch.latencyMs)
  }
  if (patch.entryKind !== undefined) {
    sets.push('entry_kind = ?')
    args.push(patch.entryKind)
  }
  if (patch.listen !== undefined) {
    sets.push('listen = ?')
    args.push(patch.listen)
  }
  run(`UPDATE tunnel SET ${sets.join(', ')} WHERE id = ?`, ...args, id)
  return true
}

// ---------------------------------------------------------------- 证据 / 攻击链

export function addHttpEvidence(input: {
  vulnId?: number | null
  assetId?: number | null
  label?: string
  method?: string
  url?: string
  status?: number
  request?: string
  response?: string
  note?: string
  capturedBy?: string
}): number {
  run(
    `INSERT INTO http_evidence (vuln_id, asset_id, label, method, url, status, request, response, note, captured_by, captured_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    input.vulnId ?? null,
    input.assetId ?? null,
    input.label ?? null,
    input.method ?? null,
    input.url ?? null,
    input.status ?? null,
    input.request ?? null,
    input.response ?? null,
    input.note ?? null,
    input.capturedBy ?? null,
    nowISO()
  )
  return lastId()
}

export function addStep(input: {
  stage?: string
  title: string
  detail?: string
  assetId?: number | null
  vulnId?: number | null
  accessId?: number | null
  pointId?: number | null
  evidenceRef?: string
  tool?: string
  agent?: string
  result?: string
  recordedBy?: string
}): number {
  const nextSeq = (get<{ n: number | null }>('SELECT MAX(seq) AS n FROM attack_step')?.n ?? 0) + 1
  run(
    `INSERT INTO attack_step (seq, stage, title, detail, asset_id, vuln_id, access_id, point_id,
      evidence_ref, tool, agent, result, recorded_by, recorded_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    nextSeq,
    input.stage ?? null,
    input.title,
    input.detail ?? null,
    input.assetId ?? null,
    input.vulnId ?? null,
    input.accessId ?? null,
    input.pointId ?? null,
    input.evidenceRef ?? null,
    input.tool ?? null,
    input.agent ?? null,
    input.result ?? null,
    input.recordedBy ?? null,
    nowISO()
  )
  return lastId()
}

export function listSteps(assetId?: number, limit = 200): Record<string, unknown>[] {
  if (assetId != null) {
    return all('SELECT * FROM attack_step WHERE asset_id = ? ORDER BY seq, id LIMIT ?', assetId, Math.min(limit, 500))
  }
  return all('SELECT * FROM attack_step ORDER BY seq, id LIMIT ?', Math.min(limit, 500))
}

// ---------------------------------------------------------------- 计分

export function scorePointsMap(): Map<string, BuiltinScorePoint> {
  const rows = all<{
    code: string
    name: string
    category: string
    points: number
    cap: number
    dedup_scope: string
    rule: number
    tier: string
    src: number
    description: string
    enabled: number
  }>('SELECT code, name, category, points, cap, dedup_scope, rule, tier, src, description, enabled FROM score_point')
  const map = new Map<string, BuiltinScorePoint>()
  for (const r of rows) {
    if (Number(r.enabled) === 0) continue
    map.set(r.code, {
      src: r.src,
      rule: r.rule,
      tier: r.tier,
      code: r.code,
      name: r.name,
      category: r.category,
      points: r.points,
      cap: r.cap,
      dedup_scope: r.dedup_scope,
      description: r.description
    })
  }
  return map
}

export function findScorePoint(code: string): { id: number; code: string; name: string; points: number } | undefined {
  return get<{ id: number; code: string; name: string; points: number }>(
    'SELECT id, code, name, points FROM score_point WHERE code = ?',
    code
  )
}

export function addScoreHit(input: {
  code: string
  assetId?: number | null
  vulnId?: number | null
  stepId?: number | null
  target?: string
  evidence?: string
  note?: string
  selfCreated?: boolean
  port?: number | null
  points?: number | null
  multiplier?: number | null
  recordedBy?: string
}): { id: number; pointCode: string; points: number } {
  const point = findScorePoint(input.code)
  if (!point) throw new Error(`未知得分点：${input.code}。先调用 redteam_score_list 看可用分值。`)
  run(
    `INSERT INTO score_hit (point_id, asset_id, vuln_id, step_id, target, evidence, note,
      self_created, port, points, multiplier, recorded_by, recorded_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    point.id,
    input.assetId ?? null,
    input.vulnId ?? null,
    input.stepId ?? null,
    input.target ?? null,
    input.evidence ?? null,
    input.note ?? null,
    input.selfCreated ? 1 : 0,
    input.port ?? null,
    input.points ?? null,
    input.multiplier ?? null,
    input.recordedBy ?? null,
    nowISO()
  )
  return { id: lastId(), pointCode: point.code, points: input.points ?? point.points }
}

/** 新增/修改得分点。内置点（builtin=1）只允许改启用状态。 */
export function saveScorePoint(input: {
  id?: number
  code?: string
  name: string
  category?: string
  points?: number
  description?: string
  enabled?: boolean
}): { id: number; code: string } {
  const now = nowISO()
  if (input.id != null) {
    const row = get<{ id: number; code: string; builtin: number }>(
      'SELECT id, code, builtin FROM score_point WHERE id = ?',
      input.id
    )
    if (!row) throw new Error(`得分点不存在：${input.id}`)
    if (Number(row.builtin) === 1) {
      run('UPDATE score_point SET enabled = ?, updated_at = ? WHERE id = ?', input.enabled === false ? 0 : 1, now, input.id)
      return { id: row.id, code: row.code }
    }
    run(
      `UPDATE score_point SET name = ?, category = COALESCE(?, category), points = COALESCE(?, points),
        description = COALESCE(?, description), enabled = COALESCE(?, enabled), updated_at = ? WHERE id = ?`,
      input.name,
      input.category ?? null,
      input.points ?? null,
      input.description ?? null,
      input.enabled === undefined ? null : input.enabled ? 1 : 0,
      now,
      input.id
    )
    return { id: row.id, code: row.code }
  }
  const code = (input.code ?? '').trim() || slugify(input.name)
  run(
    `INSERT INTO score_point (code, name, category, points, description, enabled, sort_order, cap, dedup_scope, legacy, builtin, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,0,'target',0,0,?,?)`,
    code,
    input.name,
    input.category ?? null,
    input.points ?? 0,
    input.description ?? null,
    input.enabled === false ? 0 : 1,
    999,
    now,
    now
  )
  return { id: lastId(), code }
}

/** 读全部命中并走唯一计分入口。 */
export function scoreBoard(): ScoreBoard & { pointNames: Map<string, string> } {
  const rows = all<{
    id: number
    point_id: number
    code: string
    points: number | null
    multiplier: number | null
    self_created: number
    asset_id: number | null
    target: string | null
    port: number | null
    evidence: string | null
    note: string | null
    recorded_at: string | null
  }>(
    `SELECT h.id, h.point_id, p.code, h.points, h.multiplier, h.self_created, h.asset_id,
            h.target, h.port, h.evidence, h.note, h.recorded_at
     FROM score_hit h JOIN score_point p ON p.id = h.point_id
     ORDER BY h.recorded_at, h.id`
  )
  const map = scorePointsMap()
  const board = evaluateScoreBoard(rows, map)
  const pointNames = new Map<string, string>()
  for (const [code, p] of map.entries()) pointNames.set(code, p.name)
  return { ...board, pointNames }
}


// ---------------------------------------------------------------- 证据截图

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

/**
 * 登记一张证据截图：把图片拷进靶标目录，库里只存文件名与元数据。
 * kind 必须区分 screenshot（现场截图）与 card（由记录生成的摘录卡）——
 * 混在一起会把生成的卡当成现场证据，交付时说不清。
 */
export function addShot(input: {
  path?: string
  dataBase64?: string
  label?: string
  kind?: string
  pointCode?: string
  hitId?: number
  assetId?: number
  target?: string
  note?: string
  sourceRef?: string
  capturedAt?: string
  agent?: string
}): { id: number; file: string } {
  const id = requireEngagementId()
  const dir = shotsDirOf(id)
  let fileName: string
  let bytes = 0
  let mime: string | null = null

  if (input.dataBase64?.trim()) {
    const raw = input.dataBase64.trim().replace(/^data:[^;]+;base64,/, '')
    const buf = Buffer.from(raw, 'base64')
    bytes = buf.length
    mime = /^data:([^;]+);base64,/.exec(input.dataBase64)?.[1] ?? 'image/png'
    fileName = `shot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`
    writeFileSync(join(dir, fileName), buf)
  } else if (input.path?.trim()) {
    const src = input.path.trim()
    if (!existsSync(src)) throw new Error(`图片不存在：${src}`)
    fileName = `${Date.now()}-${src.split(/[\\/]/).pop() ?? 'shot.png'}`
    copyFileSync(src, join(dir, fileName))
    bytes = statSync(join(dir, fileName)).size
    const ext = ('.' + fileName.split('.').pop()).toLowerCase()
    mime = MIME_BY_EXT[ext] ?? null
  } else {
    throw new Error('shot 需要 path 或 data_base64 之一')
  }

  const pointId = input.pointCode ? findScorePoint(input.pointCode)?.id ?? null : null
  run(
    `INSERT INTO shot (point_id, hit_id, asset_id, vuln_id, target, label, note, file, kind,
      mime, bytes, sha256, source_ref, captured_at, found_by_agent, agent, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    pointId,
    input.hitId ?? null,
    input.assetId ?? null,
    null,
    input.target ?? null,
    input.label ?? null,
    input.note ?? null,
    fileName,
    input.kind === 'card' ? 'card' : 'screenshot',
    mime,
    bytes,
    sha256(join(dir, fileName)),
    input.sourceRef ?? input.path ?? null,
    input.capturedAt ?? nowISO(),
    input.agent ?? null,
    input.agent ?? null,
    nowISO()
  )
  return { id: lastId(), file: fileName }
}

export function listShots(filter: {
  pointCode?: string
  hitId?: number
  assetId?: number
}): Record<string, unknown>[] {
  const where: string[] = []
  const args: unknown[] = []
  if (filter.pointCode?.trim()) {
    where.push('point_id = (SELECT id FROM score_point WHERE code = ?)')
    args.push(filter.pointCode.trim())
  }
  if (filter.hitId != null) {
    where.push('hit_id = ?')
    args.push(filter.hitId)
  }
  if (filter.assetId != null) {
    where.push('asset_id = ?')
    args.push(filter.assetId)
  }
  const rows = all(
    'SELECT * FROM shot' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY id DESC LIMIT 500',
    ...args
  )
  const dir = shotsDirOf(requireEngagementId())
  return rows.map((r) => ({ ...r, absolutePath: join(dir, String(r.file)) }))
}

export function deleteShot(id: number): boolean {
  const row = get<{ id: number; file: string }>('SELECT id, file FROM shot WHERE id = ?', id)
  if (!row) return false
  const file = join(shotsDirOf(requireEngagementId()), row.file)
  try {
    rmSync(file, { force: true })
  } catch {
    /* 文件删不掉不阻断记录删除 */
  }
  run('DELETE FROM shot WHERE id = ?', id)
  return true
}

// ---------------------------------------------------------------- 攻击文件

/** 保存一个实际生效的攻击文件到 <靶标>/attack-files/<目标>/。 */
export function addAttackFile(input: {
  target: string
  name: string
  kind?: string
  description?: string
  evidence: string
  content?: string
  path?: string
  assetId?: number
  vulnId?: number
  createdBy?: string
}): { id: number; file: string } {
  const id = requireEngagementId()
  if (!input.evidence?.trim()) throw new Error('evidence 必填：只收录实际生效的东西')
  const safeTarget = input.target.trim().replace(/[\\/:*?"<>|]/g, '_')
  const dir = join(attackFilesDirOf(id), safeTarget)
  mkdirSync(dir, { recursive: true })
  const safeName = input.name.trim().replace(/[\\/:*?"<>|]/g, '_')
  const dest = join(dir, safeName)

  if (input.content !== undefined && input.content !== '') {
    writeFileSync(dest, input.content, 'utf-8')
  } else if (input.path?.trim()) {
    if (!existsSync(input.path.trim())) throw new Error(`文件不存在：${input.path}`)
    copyFileSync(input.path.trim(), dest)
  } else {
    throw new Error('attack_file 需要 content 或 path 之一')
  }

  run(
    `INSERT OR REPLACE INTO attack_file (target, target_kind, name, kind, path, description, evidence,
      asset_id, vuln_id, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    input.target.trim(),
    null,
    safeName,
    input.kind ?? null,
    dest,
    input.description ?? null,
    input.evidence,
    input.assetId ?? null,
    input.vulnId ?? null,
    input.createdBy ?? null,
    nowISO()
  )
  return { id: lastId(), file: dest }
}

export function listAttackFiles(target?: string): Record<string, unknown>[] {
  if (target?.trim()) {
    return all('SELECT * FROM attack_file WHERE target LIKE ? ORDER BY target, name LIMIT 500', '%' + target.trim() + '%')
  }
  return all('SELECT * FROM attack_file ORDER BY target, name LIMIT 500')
}

// ---------------------------------------------------------------- 总览类查询

/** 一屏总览可复用入口：WebShell / 隧道 / 凭据 / 访问会话 / 资产与得分摘要。 */
export function sessionsOverview(): Record<string, unknown> {
  const shells = all<Record<string, unknown>>('SELECT * FROM webshell ORDER BY id DESC LIMIT 200')
  const tunnels: Array<Record<string, unknown> & { legit: boolean | null }> = all<Record<string, unknown>>(
    'SELECT * FROM tunnel ORDER BY id DESC LIMIT 200'
  ).map((t) => ({ ...t, legit: tunnelIsLegit(t.entry_kind as string | null) }))
  const creds = all('SELECT id, host, username, privilege, secret_type, found_at FROM credential ORDER BY id DESC LIMIT 200')
  const access = all('SELECT * FROM access_session ORDER BY id DESC LIMIT 200')
  const board = scoreBoard()
  return {
    engagement: currentEngagement(),
    webshells: { total: shells.length, active: shells.filter((s) => s.status === 'active').length, items: shells },
    tunnels: {
      total: tunnels.length,
      active: tunnels.filter((t) => t.status === 'active').length,
      legit: tunnels.filter((t) => t.legit === true).length,
      items: tunnels
    },
    credentials: { total: creds.length, items: creds },
    accessSessions: { total: access.length, items: access },
    score: { total: board.total, max: board.maxTotal, counted: board.counted }
  }
}

/** Web 资产清单：有 URL 的端口，可直接点开。 */
export function webList(cidr?: string, limit = 200): Record<string, unknown>[] {
  const where = ["p.url IS NOT NULL AND p.url != ''"]
  const args: unknown[] = []
  if (cidr?.trim()) {
    where.push('a.segment_cidr = ?')
    args.push(cidr.trim())
  }
  return all(
    `SELECT p.id AS port_id, a.id AS asset_id, a.ip, a.segment_cidr, p.port, p.proto,
            p.url, p.title, s.name AS service, s.product, s.version
     FROM port p JOIN asset a ON a.id = p.asset_id
     LEFT JOIN service s ON s.port_id = p.id
     WHERE ${where.join(' AND ')}
     ORDER BY a.ip, p.port LIMIT ?`,
    ...args,
    Math.min(limit, 500)
  )
}

/** 按域名维度聚合：每个域名关联了哪些 IP。 */
export function domainIndex(): Record<string, unknown>[] {
  return all(
    `SELECT n.name AS domain, kind, COUNT(DISTINCT n.asset_id) AS assets,
            GROUP_CONCAT(DISTINCT a.ip) AS ips
     FROM asset_name n JOIN asset a ON a.id = n.asset_id
     GROUP BY n.name, n.kind
     ORDER BY assets DESC, n.name LIMIT 500`
  )
}

/** 攻击图谱：资产 → 漏洞 → 已控制。 */
export function attackPath(cidr?: string, maxNodes = 400): Record<string, unknown> {
  const where = cidr?.trim() ? 'WHERE a.segment_cidr = ?' : ''
  const args = cidr?.trim() ? [cidr.trim()] : []
  const assets = all<{ id: number; ip: string; state: string | null; segment_cidr: string }>(
    `SELECT a.id, a.ip, a.state, a.segment_cidr FROM asset a ${where} ORDER BY a.ip LIMIT ?`,
    ...args,
    Math.min(maxNodes, 2000)
  )
  const ids = assets.map((a) => a.id)
  const ph = ids.map(() => '?').join(',')
  const vulns = ids.length
    ? all<{ id: number; asset_id: number; title: string; severity: string | null; status: string | null }>(
        `SELECT id, asset_id, title, severity, status FROM vuln WHERE asset_id IN (${ph})`,
        ...ids
      )
    : []
  const owned = new Set<number>()
  if (ids.length) {
    for (const r of all<{ asset_id: number }>(
      `SELECT DISTINCT asset_id FROM webshell WHERE asset_id IN (${ph}) AND status = 'active'
       UNION SELECT DISTINCT asset_id FROM access_session WHERE asset_id IN (${ph})
       UNION SELECT DISTINCT asset_id FROM tunnel WHERE asset_id IN (${ph}) AND status = 'active'`,
      ...ids,
      ...ids,
      ...ids
    )) {
      if (r.asset_id != null) owned.add(Number(r.asset_id))
    }
  }
  return {
    nodes: assets.map((a) => ({
      id: a.id,
      ip: a.ip,
      segment: a.segment_cidr,
      state: a.state,
      owned: owned.has(a.id),
      vulns: vulns.filter((v) => v.asset_id === a.id).map((v) => ({ id: v.id, title: v.title, severity: v.severity, status: v.status }))
    })),
    stats: { assets: assets.length, owned: owned.size, vulns: vulns.length }
  }
}

/** 五个阶段的攻击链视图（阶段顺序与名称对齐上游 store-core 的 stage 定义）。 */
const STAGE_ORDER: ReadonlyArray<{ code: string; name: string; subtitle: string }> = [
  { code: 'recon', name: '信息收集', subtitle: 'RECON · 互联网侧' },
  { code: 'internet', name: '互联网资产权限', subtitle: 'INTERNET-SIDE PRIVILEGE' },
  { code: 'boundary', name: '边界突破', subtitle: 'BOUNDARY BREACH · TUNNEL' },
  { code: 'internal', name: '内网资产权限', subtitle: 'INTERNAL-SIDE PRIVILEGE' },
  { code: 'target', name: '靶标权限', subtitle: 'TARGET SYSTEM' }
]

export function attackChainView(): Record<string, unknown> {
  const steps = all<{ id: number; seq: number; stage: string | null; title: string; tool: string | null; result: string | null }>(
    'SELECT id, seq, stage, title, tool, result FROM attack_step ORDER BY seq, id LIMIT 500'
  )
  return {
    stages: STAGE_ORDER.map((s, i) => ({
      ordinal: i + 1,
      code: s.code,
      name: `${s.name}（${s.subtitle}）`,
      steps: steps.filter((x) => (x.stage ?? '') === s.code)
    })),
    unstaged: steps.filter((x) => !STAGE_ORDER.some((s) => s.code === (x.stage ?? ''))),
    total: steps.length
  }
}

export function reportTargets(target?: string): Record<string, unknown> {
  const rows = target?.trim()
    ? all<{ target: string; hits: number; points: number }>(
        `SELECT COALESCE(h.target, '（未填目标）') AS target, COUNT(*) AS hits,
                SUM(COALESCE(h.points, p.points) * COALESCE(h.multiplier, 1)) AS points
         FROM score_hit h JOIN score_point p ON p.id = h.point_id
         WHERE h.target LIKE ? GROUP BY h.target ORDER BY points DESC`,
        '%' + target.trim() + '%'
      )
    : all<{ target: string; hits: number; points: number }>(
        `SELECT COALESCE(h.target, '（未填目标）') AS target, COUNT(*) AS hits,
                SUM(COALESCE(h.points, p.points) * COALESCE(h.multiplier, 1)) AS points
         FROM score_hit h JOIN score_point p ON p.id = h.point_id
         GROUP BY h.target ORDER BY points DESC LIMIT 200`
      )
  return { targets: rows }
}


// ---------------------------------------------------------------- 角色提示词（每靶标可改）

/**
 * 角色提示词落盘在 `<靶标>/agents/<code>.md`，出厂默认来自内置 DEFAULT_PROMPTS。
 * 读的时候文件优先、内置兜底；写只写文件，不动内置常量。
 */
export function readRolePrompt(role: string): { text: string; source: 'engagement' | 'builtin' } {
  const code = role.trim() as keyof typeof REDTEAM_ROLE_PROMPTS
  const builtin = REDTEAM_ROLE_PROMPTS[code] ?? ''
  try {
    const file = join(agentsDirOf(requireEngagementId()), `${code}.md`)
    if (existsSync(file)) {
      const text = readFileSync(file, 'utf-8').trim()
      if (text) return { text, source: 'engagement' }
    }
  } catch {
    /* 没有靶标就回默认 */
  }
  return { text: builtin, source: 'builtin' }
}

export function writeRolePrompt(role: string, text: string): string {
  const code = role.trim()
  const dir = agentsDirOf(requireEngagementId())
  const file = join(dir, `${code}.md`)
  writeFileSync(file, text.trim() + '\n', 'utf-8')
  return file
}

/** 恢复出厂：删掉靶标下的覆盖文件，回到内置默认。 */
export function resetRolePrompt(role: string): boolean {
  const code = role.trim()
  const file = join(agentsDirOf(requireEngagementId()), `${code}.md`)
  try {
    rmSync(file, { force: true })
  } catch {
    return false
  }
  return true
}

// ---------------------------------------------------------------- POC 知识库（全局，跨靶标共享）

function kbAll<T = Record<string, unknown>>(sql: string, ...args: unknown[]): T[] {
  return kbDb().prepare(sql).all(...args) as T[]
}
function kbGet<T = Record<string, unknown>>(sql: string, ...args: unknown[]): T | undefined {
  return kbDb().prepare(sql).get(...args) as T | undefined
}
function kbRun(sql: string, ...args: unknown[]): void {
  kbDb().prepare(sql).run(...args)
}
function kbLastId(): number {
  return Number(kbGet<{ id: number }>('SELECT last_insert_rowid() AS id')?.id ?? 0)
}

export interface PocFilter {
  q?: string
  cve?: string
  component?: string
  kind?: string
  category?: string
  language?: string
  source?: string
  verified?: boolean
  engagement?: string
  assetTarget?: string
  limit?: number
}

export function searchPocs(filter: PocFilter): Record<string, unknown>[] {
  const where: string[] = []
  const args: unknown[] = []
  const like = (col: string, v?: string): void => {
    if (!v?.trim()) return
    where.push(`${col} LIKE ?`)
    args.push('%' + v.trim() + '%')
  }
  if (filter.q?.trim()) {
    where.push('(title LIKE ? OR description LIKE ? OR content LIKE ? OR usage LIKE ? OR tags LIKE ?)')
    const k = '%' + filter.q.trim() + '%'
    args.push(k, k, k, k, k)
  }
  like('cve', filter.cve)
  like('component', filter.component)
  like('kind', filter.kind)
  like('language', filter.language)
  like('source', filter.source)
  like('engagement_name', filter.engagement)
  like('asset_target', filter.assetTarget)
  if (filter.category?.trim()) {
    const cats = filter.category.split(/[,，\s]+/).map((c) => c.trim()).filter(Boolean)
    if (cats.length) {
      where.push(`(${cats.map(() => 'category = ?').join(' OR ')})`)
      args.push(...cats)
    }
  }
  if (filter.verified === true) where.push('verified = 1')
  if (filter.verified === false) where.push('verified = 0')
  const limit = Math.min(Math.max(Number(filter.limit) || 200, 1), 1000)
  return kbAll(
    'SELECT id, code, title, kind, category, cve, component, versions, severity, language, source, source_url, description, usage, verified, verified_note, hit_count, used_on, engagement_name, asset_target, tags, path FROM poc' +
      (where.length ? ' WHERE ' + where.join(' AND ') : '') +
      ' ORDER BY verified DESC, hit_count DESC, id DESC LIMIT ?',
    ...args,
    limit
  )
}

export function getPoc(key: { id?: number; code?: string }): Record<string, unknown> | null {
  const row = key.id != null
    ? kbGet('SELECT * FROM poc WHERE id = ?', key.id)
    : key.code?.trim()
      ? kbGet('SELECT * FROM poc WHERE code = ?', key.code.trim())
      : undefined
  if (!row) return null
  let content = String(row.content ?? '')
  if (!content && row.path) {
    try {
      content = readFileSync(String(row.path), 'utf-8')
    } catch {
      content = ''
    }
  }
  return { ...row, content }
}

export function addPoc(input: {
  title: string
  kind?: string
  category?: string
  cve?: string
  component?: string
  versions?: string
  severity?: string
  language?: string
  source?: string
  sourceUrl?: string
  description?: string
  usage?: string
  content?: string
  path?: string
  filename?: string
  verified?: boolean
  verifiedNote?: string
  engagementName?: string
  assetTarget?: string
  foundByAgent?: string
  tags?: string
  createdBy?: string
}): { id: number; code: string; path: string | null } {
  const code = slugify(input.title).slice(0, 80)
  const existing = kbGet<{ id: number; code: string }>('SELECT id, code FROM poc WHERE code = ?', code)
  const language = input.language ?? 'text'
  const ext: Record<string, string> = {
    python: 'py', py: 'py', go: 'go', java: 'java', bash: 'sh', sh: 'sh',
    http: 'http', nuclei: 'yaml', js: 'js', php: 'php', text: 'txt'
  }
  let savedPath: string | null = null
  const body = input.content ?? ''
  if (body || input.path) {
    const dir = join(pocsDir(), code)
    mkdirSync(dir, { recursive: true })
    const fname = input.filename?.trim() || `poc.${ext[language] ?? 'txt'}`
    const dest = join(dir, fname)
    if (body) writeFileSync(dest, body, 'utf-8')
    else if (input.path?.trim() && existsSync(input.path.trim())) copyFileSync(input.path.trim(), dest)
    savedPath = dest
  }
  const now = nowISO()
  const text = body || (input.path ? '' : '')

  if (existing) {
    kbRun(
      `UPDATE poc SET title = ?, kind = COALESCE(?, kind), category = COALESCE(?, category),
        cve = COALESCE(?, cve), component = COALESCE(?, component), versions = COALESCE(?, versions),
        severity = COALESCE(?, severity), language = COALESCE(?, language), source = COALESCE(?, source),
        source_url = COALESCE(?, source_url), description = COALESCE(?, description),
        usage = COALESCE(?, usage), content = COALESCE(NULLIF(?, ''), content),
        path = COALESCE(?, path), verified = COALESCE(?, verified), verified_note = COALESCE(?, verified_note),
        engagement_name = COALESCE(?, engagement_name), asset_target = COALESCE(?, asset_target),
        found_by_agent = COALESCE(?, found_by_agent), tags = COALESCE(?, tags), updated_at = ?
       WHERE id = ?`,
      input.title,
      input.kind ?? null,
      input.category ?? null,
      input.cve ?? null,
      input.component ?? null,
      input.versions ?? null,
      input.severity ?? null,
      input.language ?? null,
      input.source ?? null,
      input.sourceUrl ?? null,
      input.description ?? null,
      input.usage ?? null,
      text,
      savedPath,
      input.verified === undefined ? null : input.verified ? 1 : 0,
      input.verifiedNote ?? null,
      input.engagementName ?? null,
      input.assetTarget ?? null,
      input.foundByAgent ?? null,
      input.tags ?? null,
      now,
      existing.id
    )
    return { id: existing.id, code: existing.code, path: savedPath }
  }

  kbRun(
    `INSERT INTO poc (code, title, kind, category, cve, component, versions, severity, language,
      source, source_url, description, usage, content, path, verified, verified_note,
      hit_count, engagement_name, asset_target, found_by_agent, tags, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?)`,
    code,
    input.title,
    input.kind ?? 'poc',
    input.category ?? null,
    input.cve ?? null,
    input.component ?? null,
    input.versions ?? null,
    input.severity ?? null,
    language,
    input.source ?? null,
    input.sourceUrl ?? null,
    input.description ?? null,
    input.usage ?? null,
    text,
    savedPath,
    input.verified ? 1 : 0,
    input.verifiedNote ?? null,
    input.engagementName ?? null,
    input.assetTarget ?? null,
    input.foundByAgent ?? null,
    input.tags ?? null,
    input.createdBy ?? null,
    now,
    now
  )
  return { id: kbLastId(), code, path: savedPath }
}

export function updatePoc(
  key: { id?: number; code?: string },
  patch: Record<string, unknown>,
  verified?: boolean,
  verifiedNote?: string
): boolean {
  const row = key.id != null
    ? kbGet<{ id: number }>('SELECT id FROM poc WHERE id = ?', key.id)
    : key.code?.trim()
      ? kbGet<{ id: number }>('SELECT id FROM poc WHERE code = ?', key.code.trim())
      : undefined
  if (!row) return false
  const allowed = [
    'kind', 'category', 'cve', 'component', 'versions', 'severity', 'language', 'source',
    'source_url', 'description', 'usage', 'content', 'tags', 'title'
  ]
  const sets: string[] = []
  const args: unknown[] = []
  for (const k of allowed) {
    if (patch[k] === undefined) continue
    sets.push(`${k} = ?`)
    args.push(patch[k])
  }
  const v = verified ?? (typeof patch.verified === 'boolean' ? (patch.verified as boolean) : undefined)
  if (v !== undefined) {
    sets.push('verified = ?')
    args.push(v ? 1 : 0)
  }
  const note = verifiedNote ?? (typeof patch.verified_note === 'string' ? (patch.verified_note as string) : undefined)
  if (note !== undefined) {
    sets.push('verified_note = ?')
    args.push(note)
  }
  if (!sets.length) return true
  sets.push('updated_at = ?')
  args.push(nowISO(), row.id)
  kbRun(`UPDATE poc SET ${sets.join(', ')} WHERE id = ?`, ...args)
  return true
}

export function markPocUsed(key: { id?: number; code?: string }, usedOn: string): boolean {
  const row = key.id != null
    ? kbGet<{ id: number }>('SELECT id FROM poc WHERE id = ?', key.id)
    : key.code?.trim()
      ? kbGet<{ id: number }>('SELECT id FROM poc WHERE code = ?', key.code.trim())
      : undefined
  if (!row) return false
  kbRun(
    'UPDATE poc SET hit_count = hit_count + 1, used_on = ?, updated_at = ? WHERE id = ?',
    usedOn,
    nowISO(),
    row.id
  )
  return true
}

export function pocStats(): Record<string, unknown> {
  const total = kbGet<{ n: number }>('SELECT COUNT(*) AS n FROM poc')?.n ?? 0
  const verified = kbGet<{ n: number }>('SELECT COUNT(*) AS n FROM poc WHERE verified = 1')?.n ?? 0
  const byCategory = kbAll("SELECT COALESCE(category, '未归类') AS category, COUNT(*) AS n FROM poc GROUP BY category ORDER BY n DESC")
  return { total, verified, byCategory }
}

// ---------------------------------------------------------------- 并发闸（agent slot）

const SLOT_LIMIT = 3
const slotsByEngagement = new Map<string, Array<{ key: string; label: string; at: string }>>()

export function agentSlot(action: 'status' | 'acquire' | 'release', label?: string, key?: string): Record<string, unknown> {
  const id = requireEngagementId()
  if (!slotsByEngagement.has(id)) slotsByEngagement.set(id, [])
  const list = slotsByEngagement.get(id) as Array<{ key: string; label: string; at: string }>

  if (action === 'status') {
    return { limit: SLOT_LIMIT, used: list.length, free: Math.max(0, SLOT_LIMIT - list.length), slots: list }
  }
  if (action === 'acquire') {
    if (list.length >= SLOT_LIMIT) {
      return {
        ok: false,
        reason: `已满 ${SLOT_LIMIT} 个并发执行智能体。等现有的回报后再派，不要重试硬塞。`,
        limit: SLOT_LIMIT,
        used: list.length,
        slots: list
      }
    }
    const k = key?.trim() || `slot-${Date.now().toString(36)}`
    list.push({ key: k, label: label ?? '', at: nowISO() })
    return { ok: true, key: k, limit: SLOT_LIMIT, used: list.length, slots: list }
  }
  // release
  const idx = key?.trim() ? list.findIndex((s) => s.key === key.trim()) : 0
  if (idx < 0) return { ok: false, reason: `没有找到这个槽位：${key}` , slots: list }
  const [removed] = list.splice(idx, 1)
  return { ok: true, released: removed, used: list.length, slots: list }
}

// ---------------------------------------------------------------- 连通性实测

interface ProbeResult {
  ok: boolean
  latencyMs: number
  detail: string
}

/**
 * 真实发起一次探测：HTTP(S) 走 GET，TCP 走 connect。
 * 这是唯一会主动出网的工具，且只探测用户自己登记过的入口。
 */
async function probeOnce(kind: 'http' | 'tcp', target: string, timeoutMs: number): Promise<ProbeResult> {
  const started = Date.now()
  if (kind === 'http') {
    const mod = target.startsWith('https:') ? await import('node:https') : await import('node:http')
    return await new Promise<ProbeResult>((resolve) => {
      let settled = false
      const done = (r: ProbeResult): void => {
        if (settled) return
        settled = true
        resolve(r)
      }
      const req = mod.request(
        target,
        { method: 'GET', timeout: timeoutMs, rejectUnauthorized: false },
        (res) => {
          res.resume()
          done({
            ok: true,
            latencyMs: Date.now() - started,
            detail: `HTTP ${res.statusCode ?? 0}`
          })
        }
      )
      req.on('timeout', () => {
        req.destroy()
        done({ ok: false, latencyMs: Date.now() - started, detail: 'timeout' })
      })
      req.on('error', (e) => done({ ok: false, latencyMs: Date.now() - started, detail: e.message }))
      req.end()
    })
  }
  const net = await import('node:net')
  const m = /^(?:socks5:\/\/|socks4:\/\/|http:\/\/)?([^:/]+):(\d{1,5})/.exec(target)
  if (!m) return { ok: false, latencyMs: 0, detail: '地址解析失败，需要 host:port' }
  const host = m[1]
  const port = Number(m[2])
  return await new Promise<ProbeResult>((resolve) => {
    let settled = false
    const done = (r: ProbeResult): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(r)
    }
    const socket = net.connect({ host, port, timeout: timeoutMs })
    socket.on('connect', () => done({ ok: true, latencyMs: Date.now() - started, detail: 'TCP connected' }))
    socket.on('timeout', () => done({ ok: false, latencyMs: Date.now() - started, detail: 'timeout' }))
    socket.on('error', (e) => done({ ok: false, latencyMs: Date.now() - started, detail: e.message }))
  })
}

/** 实测所有 WebShell 与隧道的连通性，并把结果回写库里。 */
export async function sessionCheck(timeoutMs = 6000): Promise<Record<string, unknown>> {
  const timeout = Math.min(Math.max(Number(timeoutMs) || 6000, 1000), 30000)
  const shells = listWebshells(undefined, 100)
  const tunnels = listTunnels(undefined, 100)
  const shellResults: Array<Record<string, unknown>> = []
  for (const s of shells) {
    const url = String(s.url ?? '')
    if (!/^https?:\/\//i.test(url)) {
      shellResults.push({ id: s.id, url, ok: false, detail: '不是 http(s) URL，跳过实测' })
      continue
    }
    const r = await probeOnce('http', url, timeout)
    updateWebshell(Number(s.id), {
      status: r.ok ? 'active' : 'dead',
      latencyMs: r.latencyMs,
      note: r.detail
    })
    shellResults.push({ id: s.id, url, ...r })
  }
  const tunnelResults: Array<Record<string, unknown>> = []
  for (const t of tunnels) {
    const listen = String(t.listen ?? '')
    if (!listen) {
      tunnelResults.push({ id: t.id, listen: '', ok: false, detail: '未填监听地址，无法实测' })
      continue
    }
    const r = await probeOnce('tcp', listen, timeout)
    updateTunnel(Number(t.id), {
      status: r.ok ? 'active' : 'dead',
      latencyMs: r.latencyMs,
      note: r.detail
    })
    tunnelResults.push({ id: t.id, listen, ...r })
  }
  return {
    webshells: shellResults,
    tunnels: tunnelResults,
    note: '只探测你自己登记过的入口地址；结果已回写到库里的 status / latency_ms / check_note。'
  }
}

// ---------------------------------------------------------------- 得分报告（Markdown）

export function scoreReport(limit = 500): { markdown: string; items: Array<Record<string, unknown>> } {
  const board = scoreBoard()
  const eng = currentEngagement()
  const counted = board.rows
    .filter((r) => !r.capped && Number(r.self_created) !== 1)
    .slice(0, Math.min(limit, 2000))
  const pointDetail = scorePointsMap()

  const lines: string[] = []
  lines.push(`# 攻击得分链路复现报告${eng ? ` · ${eng.name}` : ''}`)
  lines.push('')
  if (eng?.scope) lines.push(`**授权范围**：${eng.scope}`)
  lines.push(`**生成时间**：${new Date().toISOString()}`)
  lines.push(`**总分**：${board.total} / 上限合计 ${board.maxTotal}（计分 ${board.counted} 条 / 共记录 ${board.all} 条）`)
  lines.push('')
  lines.push('## 一、得分明细')
  lines.push('')
  if (counted.length === 0) {
    lines.push('（还没有计分记录）')
  } else {
    lines.push('| # | 得分点 | 档位 | 分值 | 目标 | 证据 |')
    lines.push('| --- | --- | --- | --- | --- | --- |')
    counted.forEach((r, i) => {
      const meta = pointDetail.get(String(r.code))
      lines.push(
        `| ${i + 1} | ${meta?.name ?? r.code} | ${meta?.tier ?? '-'} | ${r.effective} | ${r.target ?? '-'} | ${(r.evidence ?? '-').toString().replace(/\|/g, '\\|').slice(0, 120)} |`
      )
    })
  }
  lines.push('')

  const uncounted = board.rows.filter((r) => r.capped || Number(r.self_created) === 1)
  if (uncounted.length > 0) {
    lines.push('## 二、未计分的记录（说明口径）')
    lines.push('')
    lines.push('| 得分点 | 分值 | 原因 |')
    lines.push('| --- | --- | --- |')
    for (const r of uncounted) {
      const why =
        Number(r.self_created) === 1
          ? '自建/自注册账号，按规则不计分'
          : r.capped_reason_kind === 'dedup'
            ? '同一服务同口径已计分（去重）'
            : '超出该规则累计上限（封顶）'
      lines.push(`| ${r.code} | ${r.effective} | ${why} |`)
    }
    lines.push('')
  }

  lines.push('## 三、攻击链')
  lines.push('')
  const chain = attackChainView()
  for (const st of chain.stages as Array<{ ordinal: number; code: string; name: string; steps: Array<Record<string, unknown>> }>) {
    if (st.steps.length === 0) continue
    lines.push(`### ${st.ordinal}. ${st.name}`)
    for (const s of st.steps) {
      lines.push(`- **${String(s.title)}**`)
      if (s.tool) lines.push(`  - 命令：\`${String(s.tool)}\``)
      if (s.result) lines.push(`  - 结果：${String(s.result)}`)
    }
    lines.push('')
  }

  lines.push('## 四、入口与通道')
  lines.push('')
  const shells = listWebshells(undefined, 100)
  lines.push(`- WebShell：${shells.length} 个${shells.filter((s) => s.status === 'active').length ? `（在线 ${shells.filter((s) => s.status === 'active').length}）` : ''}`)
  const tunnels = listTunnels(undefined, 100)
  const legit = tunnels.filter((t) => t.legit === true).length
  lines.push(`- 内网隧道：${tunnels.length} 条（跨越靶标边界 ${legit} 条）`)
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('> 只收录已实际验证的成果。自建账号、同服务重复命中、超上限部分均不计分并在第二节列明。凭据明细不写入报告。')

  return {
    markdown: lines.join('\n'),
    items: counted.map((r) => ({
      code: r.code,
      points: r.effective,
      target: r.target,
      evidence: r.evidence
    }))
  }
}

