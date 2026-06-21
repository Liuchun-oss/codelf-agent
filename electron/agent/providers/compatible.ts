import type { ProviderProfile } from '@shared/agentTypes'
import { OpenAIAdapter } from './openai'


export class CompatibleAdapter extends OpenAIAdapter {
  constructor(profile: ProviderProfile, apiKey: string | null) {
    super(profile, apiKey, { allowMissingKey: true })
  }
}
