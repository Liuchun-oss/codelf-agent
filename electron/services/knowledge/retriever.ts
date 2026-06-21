import { embedOne } from './embedService'
import { searchChunks, getKb, type ChunkHit } from './store'

export interface KnowledgeSearchResult {
  ok: boolean
  hits: ChunkHit[]
  error?: string
}

export interface KnowledgeSearchOpts {
  topK?: number
  minScore?: number
}

// 在指定知识库内做语义检索。kbId 为空时返回错误（调用方需先选库）。
export async function searchKnowledge(
  kbId: string,
  query: string,
  opts: KnowledgeSearchOpts = {}
): Promise<KnowledgeSearchResult> {
  if (!kbId) return { ok: false, hits: [], error: '未指定知识库' }
  if (!getKb(kbId)) return { ok: false, hits: [], error: '知识库不存在' }
  const topK = opts.topK ?? 8
  const minScore = opts.minScore ?? 0
  let qvec: number[]
  try {
    qvec = await embedOne(query)
  } catch (e) {
    return { ok: false, hits: [], error: e instanceof Error ? e.message : '查询向量计算失败' }
  }
  try {
    const hits = searchChunks(kbId, qvec, topK).filter((h) => h.score >= minScore)
    return { ok: true, hits }
  } catch (e) {
    return { ok: false, hits: [], error: e instanceof Error ? e.message : '检索失败' }
  }
}
