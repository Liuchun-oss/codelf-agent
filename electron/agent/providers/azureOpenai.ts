import { AzureOpenAI } from 'openai'
import type { ProviderProfile } from '@shared/agentTypes'
import { getFetchOptions } from './network'
import {
  BaseProviderAdapter,
  ProviderError,
  normalizeBaseUrl,
  type ChatRequest,
  type StreamChunk
} from './base'
import { streamChatViaOpenAI } from './openai'

const DEFAULT_API_VERSION = '2024-02-15-preview'


export class AzureOpenAIAdapter extends BaseProviderAdapter {
  private client: AzureOpenAI
  private deployment: string

  constructor(profile: ProviderProfile, apiKey: string | null) {
    super()
    if (!apiKey) {
      throw new ProviderError('provider_auth', '未配置 API Key')
    }
    if (!profile.azureDeployment) {
      throw new ProviderError('provider_not_found', 'Azure 需要配置 Deployment 名称')
    }
    this.deployment = profile.azureDeployment
    this.client = new AzureOpenAI({
      apiKey,
      endpoint: normalizeBaseUrl(profile.baseUrl),
      apiVersion: profile.azureApiVersion?.trim() || DEFAULT_API_VERSION,
      deployment: profile.azureDeployment,
      timeout: profile.timeoutMs,
      maxRetries: 0,
      ...(getFetchOptions() ? { fetchOptions: getFetchOptions() } : {})
    })
  }

  streamChat(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamChunk, void, unknown> {
    
    return streamChatViaOpenAI(this.client, { ...req, model: this.deployment }, signal)
  }
}
