import OpenAI from 'openai'
import type { FimRequest, FimResult } from '@shared/agentTypes'
import { getFetchOptions } from './network'
import { normalizeBaseUrl } from './base'
import { getActiveProfileApiKey } from './profileStore'
import { getActiveProfileSummary } from './profileStore'


const FIM_MAX_TOKENS = 256


function toBetaBaseUrl(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl)
  
  return normalized.replace(/\/(v1|beta)$/i, '') + '/beta'
}



export async function fimComplete(req: FimRequest, signal?: AbortSignal): Promise<FimResult> {
  const profile = getActiveProfileSummary()
  if (!profile) return { ok: false, error: '未选择模型配置' }
  if (profile.kind !== 'deepseek') return { ok: false, error: '当前配置不是 DeepSeek，FIM 补全不可用' }
  if (!profile.fimEnabled) return { ok: false, error: 'FIM 补全未启用' }
  if (!req.prefix && !req.suffix) return { ok: true, text: '' }

  const apiKey = getActiveProfileApiKey()
  if (!apiKey) return { ok: false, error: '未配置 API Key' }

  const client = new OpenAI({
    apiKey,
    baseURL: toBetaBaseUrl(profile.baseUrl),
    timeout: profile.timeoutMs,
    maxRetries: 0,
    ...(getFetchOptions() ? { fetchOptions: getFetchOptions() } : {})
  })

  try {
    const completion = await client.completions.create(
      {
        model: profile.model,
        prompt: req.prefix,
        ...(req.suffix ? { suffix: req.suffix } : {}),
        max_tokens: req.maxTokens ?? FIM_MAX_TOKENS,
        stream: false
      },
      { signal }
    )
    const text = completion.choices?.[0]?.text ?? ''
    return { ok: true, text }
  } catch (e) {
    if (e instanceof Error && e.name === 'APIUserAbortError') return { ok: true, text: '' }
    return { ok: false, error: e instanceof Error ? e.message : 'FIM 请求失败' }
  }
}
