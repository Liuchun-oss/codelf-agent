import type { TokenUsage } from '@shared/agentTypes'


export interface RoundUsageAcc {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
}

export function createRoundUsageAcc(): RoundUsageAcc {
  return { inputTokens: 0, outputTokens: 0 }
}

export function applyStreamUsageChunk(
  acc: RoundUsageAcc,
  chunk: {
    inputTokens?: number
    outputTokens?: number
    cacheReadInputTokens?: number
    cacheCreationInputTokens?: number
  }
): void {
  if (chunk.inputTokens != null) acc.inputTokens = chunk.inputTokens
  if (chunk.outputTokens != null) acc.outputTokens = chunk.outputTokens
  if (chunk.cacheReadInputTokens != null) acc.cacheReadInputTokens = chunk.cacheReadInputTokens
  if (chunk.cacheCreationInputTokens != null) acc.cacheCreationInputTokens = chunk.cacheCreationInputTokens
}

export function computePromptCacheStatus(
  usage: Pick<TokenUsage, 'cacheReadInputTokens' | 'cacheCreationInputTokens'>,
  likelyBroken = false
): TokenUsage['promptCacheStatus'] {
  if (likelyBroken) return 'possibly_broken'
  if (usage.cacheReadInputTokens === undefined && usage.cacheCreationInputTokens === undefined) return 'unsupported'
  const read = usage.cacheReadInputTokens ?? 0
  const created = usage.cacheCreationInputTokens ?? 0
  if (read > 0) return 'hit'
  if (created > 0) return 'warming'
  return 'cold'
}


export function computePromptCacheHitRate(usage: Pick<TokenUsage, 'apiInputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens'>): number | undefined {
  if (usage.cacheReadInputTokens === undefined && usage.cacheCreationInputTokens === undefined) return undefined
  const uncached = usage.apiInputTokens ?? 0
  const read = usage.cacheReadInputTokens ?? 0
  const created = usage.cacheCreationInputTokens ?? 0
  const total = uncached + read + created
  if (total <= 0) return undefined
  return Math.round((read / total) * 10000) / 100
}

export function mergeRoundUsageIntoTurn(
  total: TokenUsage | undefined,
  round: RoundUsageAcc
): TokenUsage | undefined {
  const hasCacheUsage = round.cacheReadInputTokens !== undefined || round.cacheCreationInputTokens !== undefined
  if (round.inputTokens === 0 && round.outputTokens === 0 && !hasCacheUsage) return total
  const apiInputTokens = (total?.apiInputTokens ?? total?.inputTokens ?? 0) + round.inputTokens
  const cacheReadInputTokens =
    total?.cacheReadInputTokens !== undefined || round.cacheReadInputTokens !== undefined
      ? (total?.cacheReadInputTokens ?? 0) + (round.cacheReadInputTokens ?? 0)
      : undefined
  const cacheCreationInputTokens =
    total?.cacheCreationInputTokens !== undefined || round.cacheCreationInputTokens !== undefined
      ? (total?.cacheCreationInputTokens ?? 0) + (round.cacheCreationInputTokens ?? 0)
      : undefined
  const promptCacheHitRate = computePromptCacheHitRate({
    apiInputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens
  })
  const promptCacheStatus = computePromptCacheStatus({ cacheReadInputTokens, cacheCreationInputTokens })
  return {
    inputTokens: apiInputTokens + (cacheReadInputTokens ?? 0) + (cacheCreationInputTokens ?? 0),
    outputTokens: (total?.outputTokens ?? 0) + round.outputTokens,
    apiInputTokens,
    apiOutputTokens: (total?.apiOutputTokens ?? total?.outputTokens ?? 0) + round.outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    promptCacheHitRate,
    promptCacheStatus
  }
}
