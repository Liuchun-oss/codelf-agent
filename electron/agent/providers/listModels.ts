import type { ProfileDraft, ListRemoteModelsResult } from '@shared/agentTypes'
import { getOutboundDispatcher } from './network'
import { buildEndpointUrl, NEUTRAL_UA, endpointNeedsNeutralUa, markEndpointNeutralUa } from './base'
import { getSecret } from '../../ipc/secrets'
import { apiKeyRefFor } from './profileStore'

interface OpenAIModelListItem {
  id?: unknown
  // Anthropic /v1/models 用 id + display_name；OpenAI 兼容用 id。
  display_name?: unknown
}

interface OpenAIModelListResponse {
  data?: OpenAIModelListItem[]
  // 少数网关直接返回 { models: [...] } 或裸数组。
  models?: OpenAIModelListItem[]
}

function extractIds(payload: unknown): string[] {
  const seen = new Set<string>()
  const push = (v: unknown): void => {
    if (typeof v === 'string' && v.trim()) seen.add(v.trim())
  }
  const items: OpenAIModelListItem[] = Array.isArray(payload)
    ? (payload as OpenAIModelListItem[])
    : (payload as OpenAIModelListResponse)?.data ?? (payload as OpenAIModelListResponse)?.models ?? []
  for (const item of items) {
    if (typeof item === 'string') {
      push(item)
    } else if (item && typeof item === 'object') {
      push(item.id)
    }
  }
  return Array.from(seen).sort((a, b) => a.localeCompare(b))
}

// 拉取远端模型列表（OpenAI / Anthropic 兼容的 GET /models）。
// 失败时返回 ok:false，前端据此回退到手动输入模型名。
export async function listRemoteModels(draft: ProfileDraft): Promise<ListRemoteModelsResult> {
  if (!draft || typeof draft.baseUrl !== 'string') {
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

  const url =
    draft.kind === 'anthropic'
      ? buildEndpointUrl(draft.baseUrl, 'v1/models')
      : buildEndpointUrl(draft.baseUrl, 'models')
  if (!url) return { ok: false, error: 'Base URL 无法解析' }

  const dispatcher = getOutboundDispatcher()

  const doFetch = async (neutralUa: boolean): Promise<Response> => {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (apiKey) {
      if (draft.kind === 'anthropic') {
        headers['x-api-key'] = apiKey
        headers['anthropic-version'] = draft.azureApiVersion || '2023-06-01'
      } else {
        headers['Authorization'] = `Bearer ${apiKey}`
      }
    }
    if (neutralUa) headers['User-Agent'] = NEUTRAL_UA
    return fetch(url, {
      method: 'GET',
      headers,
      ...(dispatcher ? ({ dispatcher } as Record<string, unknown>) : {})
    })
  }

  try {
    let res: Response
    try {
      res = await doFetch(endpointNeedsNeutralUa(draft.baseUrl))
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : '网络请求失败' }
    }
    // 网关按 SDK UA 拦截 403 时，改用中性 UA 重试一次。
    if (res.status === 403 && !endpointNeedsNeutralUa(draft.baseUrl)) {
      markEndpointNeutralUa(draft.baseUrl)
      try {
        res = await doFetch(true)
      } catch {
        /* 保留原始 403 */
      }
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: 'API Key 无效或该端点不支持列出模型' }
      }
      if (res.status === 404) {
        return { ok: false, error: '该端点不提供 /models 接口，请手动填写模型名' }
      }
      return { ok: false, error: `获取失败（${res.status}）${detail ? '：' + detail.slice(0, 120) : ''}` }
    }
    const payload = (await res.json()) as unknown
    const models = extractIds(payload)
    if (models.length === 0) {
      return { ok: false, error: '端点未返回任何模型，请手动填写模型名' }
    }
    return { ok: true, models }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '获取模型列表失败' }
  }
}
