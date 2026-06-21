import type { ProfileDraft, ProviderProfile, TestConnectionResult } from '@shared/agentTypes'
import { createAdapter, ProviderError, type BaseProviderAdapter } from './index'
import { lookupModelMetadata } from './modelMetadata'
import { getSecret } from '../../ipc/secrets'
import { apiKeyRefFor, getProfileRaw, updateLastTest } from './profileStore'
import { queryDeepSeekBalance, type DeepSeekBalance } from './deepseekBalance'
import { PROBE_TOOL_NAME } from '@shared/appConfig'


export async function testConnection(draft: ProfileDraft): Promise<TestConnectionResult> {
  if (!draft || typeof draft.id !== 'string') {
    return { ok: false, error: '无效的配置' }
  }

  
  try {
    const u = new URL(draft.baseUrl)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { ok: false, error: 'Base URL 必须以 http(s) 开头' }
    }
  } catch {
    return { ok: false, error: 'Base URL 格式不正确' }
  }

  
  const apiKey =
    draft.apiKey !== undefined ? (draft.apiKey === '' ? null : draft.apiKey) : getSecret(apiKeyRefFor(draft.id))

  const profile: ProviderProfile = { ...draft, apiKeyRef: apiKeyRefFor(draft.id) }

  let adapter: BaseProviderAdapter
  try {
    adapter = createAdapter(profile, apiKey)
  } catch (e) {
    return finalize(draft.id, fail(e))
  }

  
  const started = Date.now()
  try {
    await drain(adapter, profile.model, false)
  } catch (e) {
    return finalize(draft.id, fail(e))
  }
  const latencyMs = Date.now() - started

  
  const probedTools = await probeTools(adapter, profile.model)
  const supportsTools = probedTools ?? draft.supportsTools

  const meta = lookupModelMetadata(profile.kind, profile.model)

  
  let balance: DeepSeekBalance | null = null
  if (profile.kind === 'deepseek' && apiKey) {
    balance = await queryDeepSeekBalance(profile.baseUrl, apiKey)
  }

  return finalize(draft.id, {
    ok: true,
    latencyMs,
    contextWindow: meta.contextWindow,
    maxOutputTokens: meta.maxOutputTokens,
    supportsTools,
    ...(balance
      ? {
          balanceAvailable: balance.available,
          balanceTotal: balance.total,
          balanceCurrency: balance.currency
        }
      : {})
  })
}


async function drain(adapter: BaseProviderAdapter, model: string, withTool: boolean): Promise<void> {
  const tools = withTool
    ? [
        {
          name: PROBE_TOOL_NAME,
          description: 'Connectivity probe. Do not call.',
          parameters: { type: 'object', properties: {}, additionalProperties: false }
        }
      ]
    : undefined
  const gen = adapter.streamChat({
    model,
    messages: [{ role: 'user', content: 'ping' }],
    maxOutputTokens: 1,
    ...(tools ? { tools } : {})
  })
  
  for await (const _chunk of gen) {
    
  }
}


async function probeTools(adapter: BaseProviderAdapter, model: string): Promise<boolean | undefined> {
  try {
    await drain(adapter, model, true)
    return true
  } catch (e) {
    if (e instanceof ProviderError && e.httpStatus === 400) return false
    return undefined
  }
}

function fail(e: unknown): TestConnectionResult {
  if (e instanceof ProviderError) return { ok: false, error: e.message }
  return { ok: false, error: e instanceof Error ? e.message : '测试失败' }
}


function finalize(id: string, result: TestConnectionResult): TestConnectionResult {
  if (getProfileRaw(id)) {
    updateLastTest(id, { ok: result.ok, latencyMs: result.latencyMs })
  }
  return result
}
