import type { BuiltinScorePoint } from './scorePoints.data'

/**
 * 计分口径。
 *
 * 这里刻意保持「唯一实现」：面板、报告、攻击链三处总分必须一致，所以任何地方
 * 要算分都只能走 evaluateScoreBoard，不要在别处另写一套累加逻辑 —— 那必然漂移。
 *
 * 三条判定（对应上游的 G1/G3 与去重口径）：
 *   ① 去重：同一 dedup_scope 键内只保留分值最高的一条，其余标 capped
 *   ② 上限：同一 rule 的计分命中累计不超过 cap，超出部分按分值从高到低截断
 *   ③ 自建账号：self_created=1 的命中永不计分（演练得分针对「拿到别人已有的」）
 */

export interface ScoreHitRow {
  id?: number
  code: string
  points?: number | null
  multiplier?: number | null
  self_created?: number | null
  asset_id?: number | null
  target?: string | null
  port?: number | null
  evidence?: string | null
  note?: string | null
  recorded_at?: string | null
  point_id?: number | null
}

export interface ScoredHitRow extends ScoreHitRow {
  /** 本条实际计入的分值（已乘倍率） */
  effective: number
  capped: boolean
  capped_reason_kind: 'dedup' | 'cap' | null
  capped_by_id: number | null
  cap_group: string
  dedup_scope: string
  rule: number | null
  rule_cap: number
}

export interface ScoreBoard {
  rows: ScoredHitRow[]
  /** 计分命中总分 */
  total: number
  /** 规则上限合计（cap=0 的规则不计入） */
  maxTotal: number
  /** 计分条数 / 总条数 */
  counted: number
  all: number
}

export function parseTargetPort(target: string | null | undefined): number | null {
  const t = String(target || '').trim()
  if (t === '') return null
  const url = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\s]+)/i.exec(t)
  const authority = url !== null ? url[1] : (/^([^\s/?#]+)/.exec(t) || [])[1]
  if (!authority) return null
  const m = /:(\d{1,5})$/.exec(authority)
  if (m === null) return null
  const n = Number(m[1])
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null
}

function normalizePort(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null
}

/**
 * 从 target 取服务标识 host[:port]。没写端口时按协议补默认端口，
 * 让 `http://h/x` 与 `http://h:80/y` 归到同一个服务 —— 否则同一个服务被算两次分。
 */
function targetAuthority(target: string | null | undefined): string | null {
  const t = String(target || '').trim()
  if (t === '') return null
  const url = /^([a-z][a-z0-9+.-]*):\/\/([^/?#\s]+)/i.exec(t)
  const scheme = url !== null ? url[1].toLowerCase() : null
  const authority = url !== null ? url[2] : (/^([^\s/?#]+)/.exec(t) || [])[1]
  if (!authority) return null
  const host = authority.replace(/:\d{1,5}$/, '').toLowerCase()
  if (host === '') return null
  let port = parseTargetPort(t)
  if (port === null) {
    if (scheme === 'http') port = 80
    else if (scheme === 'https') port = 443
  }
  return port === null ? host : host + ':' + port
}

/**
 * 服务键：封顶粒度 = 同一资产的同一端口。
 * target 能解析就用 `t<host[:port]>`（同一条成果可能有人写了 asset_id、有人只写 target，
 * 以目标为准才能归到一起）；否则退到 `a<id>:<port>`；两者都没有返回 null（不参与封顶）。
 */
export function scoreServiceKey(hit: ScoreHitRow): string | null {
  const authority = targetAuthority(hit.target)
  if (authority !== null) return 't' + authority
  const assetId =
    hit.asset_id === null || hit.asset_id === undefined ? null : Number(hit.asset_id)
  if (assetId === null || !Number.isFinite(assetId)) return null
  const port = normalizePort(hit.port)
  return 'a' + assetId + ':' + (port === null ? 0 : port)
}

/**
 * system 口径的键。规则原文是「同一个系统只计算一次最高权限分」，
 * 覆盖面是「同一系统 + 同一端口」：同一套系统跑在多台主机上是不同实例，各算一次。
 * 拿不到任何可区分信息时退回本条自己的 id（即各算各的）—— 宁可少封顶也不能错封。
 */
function systemKeyOf(hit: ScoreHitRow): string {
  const svc = scoreServiceKey(hit)
  const svcText = svc === null ? '' : svc
  if (svcText !== '') return svcText
  return '#hit' + String(hit.id ?? '0')
}

/** 同口径命中里挑「计分的那一条」：分值最高，同分取更早记的（id 小）。 */
function pickBestHit(list: ScoredHitRow[]): ScoredHitRow {
  return list.reduce((a, b) => {
    if (b.effective !== a.effective) return b.effective > a.effective ? b : a
    return Number(b.id) < Number(a.id) ? b : a
  }, list[0])
}

function effectivePoints(hit: ScoreHitRow, fallback: number): number {
  const raw = hit.points === null || hit.points === undefined ? fallback : Number(hit.points)
  const base = Number.isFinite(raw) ? raw : 0
  const mult = Number(hit.multiplier)
  return Math.round(base * (Number.isFinite(mult) && mult > 0 ? mult : 1))
}

/**
 * 把命中行按口径标出「哪条计分、哪条被封顶/超上限」。纯函数，不碰数据库。
 * @param pointsByCode 得分点元数据（code → 定义）
 */
export function applyScoreCaps(
  rows: ScoreHitRow[],
  pointsByCode: Map<string, BuiltinScorePoint>
): ScoredHitRow[] {
  const flagged: ScoredHitRow[] = (rows || []).map((r) => {
    const meta = pointsByCode.get(r.code)
    const rule = meta ? Number(meta.rule) : null
    return {
      ...r,
      effective: effectivePoints(r, meta ? meta.points : 0),
      capped: false,
      capped_reason_kind: null,
      capped_by_id: null,
      cap_group: rule === null ? 'code:' + String(r.code || '') : 'rule:' + rule,
      dedup_scope: meta ? meta.dedup_scope : 'none',
      rule: Number.isFinite(rule as number) ? (rule as number) : null,
      rule_cap: meta && Number(meta.cap) > 0 ? Number(meta.cap) : 0
    }
  })

  // ① 去重：同一口径键内只留最高分
  const buckets = new Map<string, ScoredHitRow[]>()
  for (const r of flagged) {
    if (Number(r.self_created) === 1) continue
    const scope = r.dedup_scope
    if (scope === 'none') continue
    let key: string | null = null
    if (scope === 'target') key = 'target'
    else if (scope === 'system') key = 'sys:' + systemKeyOf(r)
    else {
      // service 口径拿不到服务键时不参与去重（各算各的），不能退回「每条自成一键」
      const svc = scoreServiceKey(r)
      if (svc === null || svc === '') continue
      key = 'svc:' + svc
    }
    if (key === null) continue
    const k = r.cap_group + '|' + key
    const list = buckets.get(k)
    if (list) list.push(r)
    else buckets.set(k, [r])
  }
  for (const list of buckets.values()) {
    if (list.length < 2) continue
    const best = pickBestHit(list)
    for (const r of list) {
      if (r === best) continue
      r.capped = true
      r.capped_reason_kind = 'dedup'
      r.capped_by_id = best.id ?? null
    }
  }

  // ② 规则上限：同一 rule 的分值从高到低累计，超出的标 capped
  const byRule = new Map<string, ScoredHitRow[]>()
  for (const r of flagged) {
    if (r.capped || Number(r.self_created) === 1) continue
    if (r.rule_cap <= 0) continue
    const list = byRule.get(r.cap_group)
    if (list) list.push(r)
    else byRule.set(r.cap_group, [r])
  }
  for (const list of byRule.values()) {
    const cap = list[0].rule_cap
    const ordered = [...list].sort((a, b) => {
      if (b.effective !== a.effective) return b.effective - a.effective
      return Number(a.id ?? 0) - Number(b.id ?? 0)
    })
    let acc = 0
    for (const r of ordered) {
      if (acc + r.effective > cap) {
        r.capped = true
        r.capped_reason_kind = 'cap'
        r.capped_by_id = null
        continue
      }
      acc += r.effective
    }
  }

  return flagged
}

/** 唯一入口：给一组命中行算出总分 / 满分 / 逐条判定。 */
export function evaluateScoreBoard(
  rows: ScoreHitRow[],
  pointsByCode: Map<string, BuiltinScorePoint>
): ScoreBoard {
  const scored = applyScoreCaps(rows, pointsByCode)
  let total = 0
  let counted = 0
  for (const r of scored) {
    if (r.capped || Number(r.self_created) === 1) continue
    total += r.effective
    counted += 1
  }
  let maxTotal = 0
  const seenRule = new Set<string>()
  for (const p of pointsByCode.values()) {
    const group = 'rule:' + p.rule
    if (seenRule.has(group)) continue
    seenRule.add(group)
    if (Number(p.cap) > 0) maxTotal += Number(p.cap)
  }
  return { rows: scored, total, maxTotal, counted, all: scored.length }
}

/** 隧道是否真的跨越了靶标边界。self-only（只在自己 VPS 上开的代理）不算突破。 */
export function tunnelIsLegit(entryKind: string | null | undefined): boolean | null {
  const k = String(entryKind || '').trim()
  if (k === '') return null
  return k !== 'self-only'
}

export const TUNNEL_ENTRY_KINDS: Record<string, string> = {
  'target-outbound': '目标主动连出（反弹 shell / 目标上跑 frp 客户端）',
  'target-http': '经目标 WebShell/HTTP 通道（suo5 / Neo-ReGeorg）',
  'target-agent': '经目标已控进程/会话转发（SSH -R 等）',
  'self-only': '只在自己 VPS/自建服务器上（不算突破）'
}
