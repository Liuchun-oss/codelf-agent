import type { ProviderKind } from '@shared/agentTypes'
import table from './modelMetadata.json'



export interface ModelMetadata {
  contextWindow: number
  maxOutputTokens: number
}

const TABLE: Record<string, ModelMetadata> = table as Record<string, ModelMetadata>


const KIND_DEFAULTS: Record<ProviderKind, ModelMetadata> = {
  openai: { contextWindow: 500000, maxOutputTokens: 16384 },
  'azure-openai': { contextWindow: 500000, maxOutputTokens: 16384 },
  anthropic: { contextWindow: 200000, maxOutputTokens: 8192 },
  'openai-compatible': { contextWindow: 500000, maxOutputTokens: 8192 },
  deepseek: { contextWindow: 1048576, maxOutputTokens: 393216 },
  dify: { contextWindow: 500000, maxOutputTokens: 8192 }
}


// Kimi K3 支持顶层 reasoning_effort（low/high/max，默认 max），且始终思考。
// 用于判断是否应把 profile.reasoningEffort 透传给 OpenAI 兼容端点。
export function isKimiReasoningModel(model: string): boolean {
  return /^kimi-k3/i.test(model.trim())
}

export function lookupModelMetadata(kind: ProviderKind, model: string): ModelMetadata {
  const id = model.trim()
  const exact = TABLE[id]
  if (exact) return exact

  let best: { key: string; meta: ModelMetadata } | null = null
  for (const [key, meta] of Object.entries(TABLE)) {
    if (id.startsWith(key) && (!best || key.length > best.key.length)) {
      best = { key, meta }
    }
  }
  if (best) return best.meta

  return KIND_DEFAULTS[kind] ?? KIND_DEFAULTS['openai-compatible']
}
