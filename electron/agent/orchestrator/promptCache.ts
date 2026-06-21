import { createHash } from 'crypto'
import type { ProviderKind } from '@shared/agentTypes'
import type { PromptCacheOptions } from '../providers'
import { APP_SLUG } from '@shared/appConfig'

export interface PromptCacheKeyParams {
  sessionId?: string
  profileId: string
  providerKind: ProviderKind
  model: string
  workspaceRoot?: string | null
  /** 仅 hash 静态核心段，不包含 git/memory/skills 等会话内可变内容 */
  staticSystemCore?: string
}

export function buildPromptCacheKey(params: PromptCacheKeyParams): string {
  const systemHash = params.staticSystemCore
    ? createHash('sha256').update(params.staticSystemCore).digest('hex').slice(0, 16)
    : ''
  const raw = [
    params.profileId,
    params.providerKind,
    params.model,
    params.sessionId || 'default',
    params.workspaceRoot || '',
    systemHash
  ].join('\n')
  return `${APP_SLUG}-${createHash('sha256').update(raw).digest('hex').slice(0, 32)}`
}

export function buildPromptCacheOptions(providerKind: ProviderKind): PromptCacheOptions | undefined {
  if (providerKind !== 'anthropic') return undefined
  return {
    enabled: true,
    ttl: '5m',
    cacheSystem: true,
    cacheMessages: true
  }
}
