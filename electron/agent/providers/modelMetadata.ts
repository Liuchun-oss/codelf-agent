import type { ProviderKind } from '@shared/agentTypes'
import table from './modelMetadata.json'



export interface ModelMetadata {
  contextWindow: number
  maxOutputTokens: number
}

const TABLE: Record<string, ModelMetadata> = table as Record<string, ModelMetadata>


const KIND_DEFAULTS: Record<ProviderKind, ModelMetadata> = {
  openai: { contextWindow: 128000, maxOutputTokens: 16384 },
  'azure-openai': { contextWindow: 128000, maxOutputTokens: 16384 },
  anthropic: { contextWindow: 200000, maxOutputTokens: 8192 },
  'openai-compatible': { contextWindow: 128000, maxOutputTokens: 8192 },
  deepseek: { contextWindow: 1048576, maxOutputTokens: 393216 },
  dify: { contextWindow: 128000, maxOutputTokens: 8192 }
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
