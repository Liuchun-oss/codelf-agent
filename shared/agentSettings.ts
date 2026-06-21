
export type DeferredToolPolicySetting = 'explicit' | 'auto' | 'non-core'

export interface AgentBehaviorSettings {
  
  maxToolSteps: number
  
  maxTurnDurationMs: number
  
  acceptEditsAutoApplyDelayMs: number
  
  deferredToolPolicy: DeferredToolPolicySetting
  
  deferredToolAutoThresholdChars: number
  // 是否在每轮对话时自动检索知识库并把命中片段注入上下文。
  knowledgeInjectEnabled: boolean
  // 自动注入使用的知识库 id；空串表示用最近创建的知识库。
  knowledgeKbId: string
  // 每轮注入的最相关片段数量。
  knowledgeTopK: number
  // 相似度下限（0–1），低于此值的片段不注入/不返回。
  knowledgeMinScore: number
}


export interface NetworkSettings {
  
  proxyUrl: string
  
  useSystemProxy: boolean
  
  caCertPath: string
}

export const DEFAULT_NETWORK_SETTINGS: NetworkSettings = {
  proxyUrl: '',
  useSystemProxy: true,
  caCertPath: ''
}


export function normalizeNetworkSettings(partial: Partial<NetworkSettings>): NetworkSettings {
  return {
    proxyUrl: typeof partial.proxyUrl === 'string' ? partial.proxyUrl.trim() : DEFAULT_NETWORK_SETTINGS.proxyUrl,
    useSystemProxy:
      typeof partial.useSystemProxy === 'boolean'
        ? partial.useSystemProxy
        : DEFAULT_NETWORK_SETTINGS.useSystemProxy,
    caCertPath: typeof partial.caCertPath === 'string' ? partial.caCertPath.trim() : DEFAULT_NETWORK_SETTINGS.caCertPath
  }
}




export type WebSearchProvider = 'auto' | 'aliyun-iqs' | 'brave' | 'duckduckgo'


export type IqsEngineType = 'Generic' | 'GenericAdvanced' | 'LiteAdvanced' | 'Deep'


export interface WebSearchSettings {
  
  provider: WebSearchProvider
  
  iqsEngineType: IqsEngineType
}

export const DEFAULT_WEB_SEARCH_SETTINGS: WebSearchSettings = {
  provider: 'auto',
  iqsEngineType: 'Generic'
}

const WEB_SEARCH_PROVIDERS: readonly WebSearchProvider[] = ['auto', 'aliyun-iqs', 'brave', 'duckduckgo']
const IQS_ENGINE_TYPES: readonly IqsEngineType[] = ['Generic', 'GenericAdvanced', 'LiteAdvanced', 'Deep']


export function normalizeWebSearchSettings(partial: Partial<WebSearchSettings>): WebSearchSettings {
  return {
    provider: WEB_SEARCH_PROVIDERS.includes(partial.provider as WebSearchProvider)
      ? (partial.provider as WebSearchProvider)
      : DEFAULT_WEB_SEARCH_SETTINGS.provider,
    iqsEngineType: IQS_ENGINE_TYPES.includes(partial.iqsEngineType as IqsEngineType)
      ? (partial.iqsEngineType as IqsEngineType)
      : DEFAULT_WEB_SEARCH_SETTINGS.iqsEngineType
  }
}


export interface WebSearchSettingsSummary extends WebSearchSettings {
  hasIqsKey: boolean
  hasBraveKey: boolean
  effectiveProvider: Exclude<WebSearchProvider, 'auto'>
}


export interface WebSearchSettingsDraft extends Partial<WebSearchSettings> {
  iqsApiKey?: string
  braveApiKey?: string
}

export const DEFAULT_AGENT_BEHAVIOR: AgentBehaviorSettings = {
  maxToolSteps: 0,
  maxTurnDurationMs: 20 * 60 * 1000,
  acceptEditsAutoApplyDelayMs: 3000,
  deferredToolPolicy: 'explicit',
  deferredToolAutoThresholdChars: 18_000,
  knowledgeInjectEnabled: false,
  knowledgeKbId: '',
  knowledgeTopK: 5,
  knowledgeMinScore: 0.35
}

export const AGENT_BEHAVIOR_BOUNDS = {
  maxToolSteps: { min: 0, max: 200 },
  maxTurnDurationMs: { min: 60_000, max: 120 * 60 * 1000 },
  acceptEditsAutoApplyDelayMs: { min: 0, max: 60_000 },
  deferredToolAutoThresholdChars: { min: 1_000, max: 200_000 },
  knowledgeTopK: { min: 1, max: 20 },
  knowledgeMinScore: { min: 0, max: 1 }
} as const


export function normalizeAgentBehavior(
  partial: Partial<AgentBehaviorSettings>
): AgentBehaviorSettings {
  const b = AGENT_BEHAVIOR_BOUNDS
  const n = (v: unknown, min: number, max: number, fallback: number): number => {
    const x = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : fallback
    return Math.min(max, Math.max(min, x))
  }
  const policy = partial.deferredToolPolicy
  return {
    maxToolSteps: n(
      partial.maxToolSteps,
      b.maxToolSteps.min,
      b.maxToolSteps.max,
      DEFAULT_AGENT_BEHAVIOR.maxToolSteps
    ),
    maxTurnDurationMs: n(
      partial.maxTurnDurationMs,
      b.maxTurnDurationMs.min,
      b.maxTurnDurationMs.max,
      DEFAULT_AGENT_BEHAVIOR.maxTurnDurationMs
    ),
    acceptEditsAutoApplyDelayMs: n(
      partial.acceptEditsAutoApplyDelayMs,
      b.acceptEditsAutoApplyDelayMs.min,
      b.acceptEditsAutoApplyDelayMs.max,
      DEFAULT_AGENT_BEHAVIOR.acceptEditsAutoApplyDelayMs
    ),
    deferredToolPolicy:
      policy === 'explicit' || policy === 'auto' || policy === 'non-core'
        ? policy
        : DEFAULT_AGENT_BEHAVIOR.deferredToolPolicy,
    deferredToolAutoThresholdChars: n(
      partial.deferredToolAutoThresholdChars,
      b.deferredToolAutoThresholdChars.min,
      b.deferredToolAutoThresholdChars.max,
      DEFAULT_AGENT_BEHAVIOR.deferredToolAutoThresholdChars
    ),
    knowledgeInjectEnabled:
      typeof partial.knowledgeInjectEnabled === 'boolean'
        ? partial.knowledgeInjectEnabled
        : DEFAULT_AGENT_BEHAVIOR.knowledgeInjectEnabled,
    knowledgeKbId:
      typeof partial.knowledgeKbId === 'string'
        ? partial.knowledgeKbId.trim()
        : DEFAULT_AGENT_BEHAVIOR.knowledgeKbId,
    knowledgeTopK: n(
      partial.knowledgeTopK,
      b.knowledgeTopK.min,
      b.knowledgeTopK.max,
      DEFAULT_AGENT_BEHAVIOR.knowledgeTopK
    ),
    knowledgeMinScore: (() => {
      const x =
        typeof partial.knowledgeMinScore === 'number' && Number.isFinite(partial.knowledgeMinScore)
          ? partial.knowledgeMinScore
          : DEFAULT_AGENT_BEHAVIOR.knowledgeMinScore
      return Math.min(b.knowledgeMinScore.max, Math.max(b.knowledgeMinScore.min, Math.round(x * 100) / 100))
    })()
  }
}
