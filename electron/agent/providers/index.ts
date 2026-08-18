import type { ProviderProfile } from '@shared/agentTypes'
import { BaseProviderAdapter, ProviderError } from './base'
import { OpenAIAdapter } from './openai'
import { CompatibleAdapter } from './compatible'
import { AzureOpenAIAdapter } from './azureOpenai'
import { AnthropicAdapter } from './anthropic'
import { DeepSeekAdapter } from './deepseek'
import { DifyAdapter } from './dify'

export { BaseProviderAdapter, ProviderError, isTransientNetworkError } from './base'
export { parseDataUrl } from './base'
export {
  MAX_AUTO_RETRIES,
  isRetryableError,
  isRateLimitError,
  isRateLimitCode,
  retryDelayMs
} from './retryPolicy'
export type { ChatMessage, ChatRequest, StreamChunk, ToolDef, ToolCallRequest, PromptCacheOptions } from './base'


export function createAdapter(profile: ProviderProfile, apiKey: string | null): BaseProviderAdapter {
  switch (profile.kind) {
    case 'openai':
      return new OpenAIAdapter(profile, apiKey)
    case 'openai-compatible':
      return new CompatibleAdapter(profile, apiKey)
    case 'anthropic':
      return new AnthropicAdapter(profile, apiKey)
    case 'deepseek':
      return new DeepSeekAdapter(profile, apiKey)
    case 'azure-openai':
      return new AzureOpenAIAdapter(profile, apiKey)
    case 'dify':
      return new DifyAdapter(profile, apiKey)
    default:
      throw new ProviderError('unknown', `未知的 Provider 类型：${String(profile.kind)}`)
  }
}
