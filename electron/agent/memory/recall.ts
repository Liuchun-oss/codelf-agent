import { resolveProjectId } from './paths'
import { embedOne } from '../../services/knowledge/embedService'
import { recallEpisodes, reinforceEpisode, expandByEdges, type EpisodicHit } from './episodicStore'
import { getMemorySettings } from '../settings/agentSettingsStore'
import { recordDebugEvent } from '../orchestrator/debugLog'

// 主动联想召回（轨道 A 读取入口，方案核心机制 1）。
//
// 每轮用用户当前输入做向量召回，跨会话/跨项目找出相关情景记忆，渲染成注入块。
// 关键约束（缓存安全）：
// - 该块每轮随输入变化，必须由调用方注入到「消息数组尾部 / 当前用户消息之前」，
//   绝不进 system、不写历史。这样静态 system 前缀与历史前缀逐字节不变，prompt 缓存全命中，
//   只有尾部这一小块（Top-N 摘要）是新算的——与现有知识库 RAG 注入完全同构。
// - best-effort：embedding/检索不可用时返回 null，静默跳过，不影响主对话。

const MAX_BLOCK_CHARS = 6_000

/** 把时间戳格式化为 YYYY-MM-DD HH:mm，供注入块标注记忆时间。 */
function fmtDate(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export interface RecallInjectionParams {
  query: string
  workspaceRoot?: string | null
  /** 当前打开/正在编辑的文件，用于代码空间锚定加分（位置细胞）。 */
  activeFile?: string | null
  topK?: number
}

/** 代码空间邻近加分：命中记忆锚定的文件 = 当前文件时显著加权。 */
function applyCodeAnchorBoost(hits: EpisodicHit[], activeFile?: string | null): EpisodicHit[] {
  if (!activeFile) return hits
  return hits
    .map((h) => (h.anchorFile && h.anchorFile === activeFile ? { ...h, score: h.score * 1.5 } : h))
    .sort((a, b) => b.score - a.score)
}

/**
 * 构建主动召回注入块。未启用 / 无输入 / 无命中 / 出错时返回 null。
 */
export async function buildRecallInjection(p: RecallInjectionParams): Promise<string | null> {
  const settings = getMemorySettings()
  if (!settings.enabled || !settings.autoRecall) return null
  const q = (p.query || '').trim()
  if (!q) return null

  try {
    const queryVec = await embedOne(q)
    if (!queryVec || queryVec.length === 0) return null

    const projectId = p.workspaceRoot ? resolveProjectId(p.workspaceRoot) : null
    const raw = recallEpisodes({ queryVec, topK: p.topK ?? 8, projectId })
    if (raw.length === 0) return null

    const hits = applyCodeAnchorBoost(raw, p.activeFile).slice(0, 5)
    if (hits.length === 0) return null

    // 模式完成：沿联想边扩散一跳，带出与命中记忆强关联的邻居（机制 1）。去重后合并。
    const seedIds = hits.map((h) => h.id)
    const neighbors = expandByEdges(seedIds, 2, projectId).filter((n) => !seedIds.includes(n.id))
    const merged = [...hits, ...neighbors]

    const lines: string[] = [
      '# 相关记忆（自动联想召回）',
      '',
      '以下是系统根据你当前输入，从历史会话中自动唤起的相关记忆，每条标注了记录时间，按时间从新到旧排列。',
      '**若多条记忆就同一事实存在冲突（如先记“男”后记“女”），一律以时间最新的为准**；若与当前任务无关请忽略。',
      '如需完整细节可用 `search_memory` 进一步检索。',
      ''
    ]
    // 注入按时间从新到旧排列，让"最新覆盖旧"对模型一目了然（解决矛盾记忆判断）。
    const ordered = [...merged].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    for (const h of ordered) {
      const where = h.anchorFile ? ` · ${h.anchorFile}` : ''
      const when = h.createdAt ? fmtDate(h.createdAt) : '未知时间'
      // 摘要过短（如旧记录只存了 markdown 标题）时回退用正文，避免丢失关键信息。
      const raw = h.summary && h.summary.length >= 12 ? h.summary : h.content
      const text = raw.replace(/\s*\n\s*/g, '　').trim()
      lines.push(`- [${when}｜${h.kind}${where}] ${text.length > 200 ? text.slice(0, 200) + '…' : text}`)
    }

    let block = lines.join('\n')
    if (block.length > MAX_BLOCK_CHARS) block = block.slice(0, MAX_BLOCK_CHARS) + '\n…（召回内容已截断）'

    // 命中再巩固：被实际注入的记忆视为"被提取"，增强其强度/τ（间隔重复，机制 4）。
    for (const h of merged) reinforceEpisode(h.id)

    recordDebugEvent({
      kind: 'memory',
      turnId: 'recall',
      label: 'episodic',
      detail: `recalled ${hits.length}+${neighbors.length} episodes for query (${q.length} chars)`
    })
    return block
  } catch {
    return null
  }
}

export interface EpisodicSearchResult {
  kind: string
  scope: string
  anchorFile: string | null
  content: string
  summary: string | null
  score: number
  createdAt?: number
  sessionId?: string | null
}

/**
 * 显式语义检索（供 search_memory 工具）。与自动召回共用向量引擎，但返回结构化结果、
 * 不做注入渲染。best-effort：不可用时返回空数组。
 */
export async function searchEpisodicMemory(params: {
  query: string
  workspaceRoot?: string | null
  limit?: number
}): Promise<EpisodicSearchResult[]> {
  const q = (params.query || '').trim()
  if (!q) return []
  try {
    const queryVec = await embedOne(q)
    if (!queryVec || queryVec.length === 0) return []
    const projectId = params.workspaceRoot ? resolveProjectId(params.workspaceRoot) : null
    const hits = recallEpisodes({ queryVec, topK: params.limit ?? 10, projectId })
    return hits.map((h) => ({
      kind: h.kind,
      scope: h.scope,
      anchorFile: h.anchorFile,
      content: h.content,
      summary: h.summary,
      score: h.score,
      createdAt: h.createdAt,
      sessionId: h.sessionId
    }))
  } catch {
    return []
  }
}
