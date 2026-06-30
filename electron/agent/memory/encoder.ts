import { randomUUID } from 'crypto'
import { resolveProjectId } from './paths'
import { embedOne } from '../../services/knowledge/embedService'
import {
  insertEpisode,
  addEdges,
  recentEpisodeIds,
  findSimilarForConflict,
  markSuperseded,
  type EpisodicScope
} from './episodicStore'
import { recordDebugEvent } from '../orchestrator/debugLog'

// 情景记忆编码器（轨道 A 写入入口）。
//
// 设计要点：
// - best-effort：算 embedding 或落库失败都被吞掉，仅记调试日志，绝不影响主对话/原 notes 写入。
// - 显著性启发式：用户硬性措辞（记住/务必/不要）→ 高分；错误修复 → 较高；普通发现 → 基准。
// - 物理路径与 project_id 由系统侧计算，Agent 不接触。
// - 阶段 0 为「双写」：调用方仍写旧 notes.md，本编码器额外异步落 episodic 库，互不阻塞。

const STRONG_HINTS = ['记住', '务必', '一定要', '不要', '禁止', '永远', 'remember', 'always', 'never']
const ERROR_HINTS = ['报错', '错误', '修复', 'bug', 'fix', 'error', '踩坑', '坑']

/** 由文本内容启发式推断显著性 salience ∈ [0,1]。 */
export function scoreSalience(text: string): number {
  const t = text.toLowerCase()
  if (STRONG_HINTS.some((h) => t.includes(h.toLowerCase()))) return 0.9
  if (ERROR_HINTS.some((h) => t.includes(h.toLowerCase()))) return 0.7
  return 0.4
}

/** 生成注入用的轻量摘要：剥离 markdown 标记，合并实质内容行，裁到约 160 字符。 */
function makeSummary(text: string): string {
  const meaningful = text
    .split('\n')
    .map((l) => l.replace(/^#{1,6}\s*/, '').replace(/^[-*+]\s*/, '').trim())
    .filter((l) => l.length > 0)
  const joined = meaningful.join('　')
  return joined.length > 160 ? joined.slice(0, 160) + '…' : joined
}

export interface EncodeParams {
  content: string
  scope: EpisodicScope
  workspaceRoot?: string | null
  sessionId?: string | null
  kind?: string
  anchorFile?: string | null
  anchorSymbol?: string | null
  model?: string
}

// 身份/偏好是"人本身"的跨项目属性 → global（切换项目仍可见）；
// 其余（decision/todo/convention/fact 等）是项目相关 → session（绑定 projectId，受工作区隔离）。
const GLOBAL_KINDS = new Set(['identity', 'preference'])

/** 按 kind 推断作用域：身份/偏好 → global，其余 → 传入的默认 scope。 */
export function scopeForKind(kind: string | undefined, fallback: EpisodicScope): EpisodicScope {
  return kind && GLOBAL_KINDS.has(kind.trim().toLowerCase()) ? 'global' : fallback
}

/**
 * 异步编码一条情景记忆到 episodic 库。best-effort：返回是否成功写入。
 * 不抛异常（内部捕获），调用方可 fire-and-forget。
 */
export async function encodeEpisode(p: EncodeParams): Promise<boolean> {
  const content = p.content?.trim()
  if (!content) return false
  try {
    const vector = await embedOne(content)
    if (!vector || vector.length === 0) return false
    const projectId = p.workspaceRoot ? resolveProjectId(p.workspaceRoot) : null
    const id = randomUUID()
    // 建联想边前先取同会话最近记忆（在本条插入之前），实现时间共现关联（机制 1 模式完成）。
    const neighbors = p.sessionId ? recentEpisodeIds(p.sessionId, 4) : []
    insertEpisode(
      {
        id,
        scope: p.scope,
        projectId,
        sessionId: p.sessionId ?? null,
        kind: p.kind ?? 'dialog',
        content,
        summary: makeSummary(content),
        anchorFile: p.anchorFile ?? null,
        anchorSymbol: p.anchorSymbol ?? null,
        salience: scoreSalience(content),
        vector
      },
      p.model ?? ''
    )
    if (neighbors.length > 0) addEdges(id, neighbors, 0.5)
    // 冲突消解：把"讲同一件事的旧版本"标记为被本条取代，召回只保留最新（字段 superseded_by）。
    const superseded = findSimilarForConflict({
      queryVec: vector,
      scope: p.scope,
      projectId,
      excludeId: id,
      threshold: 0.9
    })
    if (superseded.length > 0) {
      markSuperseded(superseded, id)
      // 与被取代的旧记忆建强关联边，保留可追溯的演化链。
      addEdges(id, superseded, 1.0)
      recordDebugEvent({
        kind: 'memory',
        sessionId: p.sessionId ?? 'unknown',
        turnId: 'encode',
        label: 'episodic',
        detail: `superseded ${superseded.length} older memory(ies)`
      })
    }
    return true
  } catch (e) {
    recordDebugEvent({
      kind: 'memory',
      sessionId: p.sessionId ?? 'unknown',
      turnId: 'encode',
      label: 'episodic',
      detail: `encode failed: ${e instanceof Error ? e.message : 'unknown'}`
    })
    return false
  }
}
