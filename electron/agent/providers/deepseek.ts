import type { ProviderProfile } from '@shared/agentTypes'
import { OpenAIAdapter } from './openai'
import type { ChatRequest, StreamChunk } from './base'


export class DeepSeekAdapter extends OpenAIAdapter {
  constructor(profile: ProviderProfile, apiKey: string | null) {
    super(profile, apiKey)
    this.dropReasoningContent = true
  }

  
  streamChat(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamChunk, void, unknown> {
    const { promptCacheKey: _ignored, ...rest } = req
    return super.streamChat(rest, signal)
  }
}
