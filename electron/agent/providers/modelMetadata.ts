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


// 请求侧 max_tokens 上限。prompt 与 max_tokens 共用同一个上下文窗口（DeepSeek / vLLM 等
// 通道按 `prompt_tokens + max_tokens ≤ 窗口` 校验），而元数据里的 maxOutputTokens 是
// "模型输出能力上限"（如 deepseek 一栏的 393216），原样当 max_tokens 发出会平白预占窗口的
// 三分之一，导致本地算着"才用 70%"、服务端直接 400 超限。这里给请求侧一个务实上限。
export const MAX_REQUEST_OUTPUT_TOKENS = 64_000

export function clampRequestMaxOutputTokens(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return MAX_REQUEST_OUTPUT_TOKENS
  return Math.min(Math.round(value), MAX_REQUEST_OUTPUT_TOKENS)
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
