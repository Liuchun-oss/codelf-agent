import type { ToolResult } from './types'
import { guardOutboundUrl } from './ssrfGuard'
import { getFetchOptions } from '../providers/network'
import { getProfileApiKey, getProfileRaw } from '../providers/profileStore'

// 「厂商原生搜索」通道：当前对话模型所属厂商自带搜索能力时，直接复用该 provider 已配置的
// API Key 调用官方搜索端点，用户无需在联网搜索设置里重复配一份 Key。
// 只识别厂商官方域名——中转站/自建网关一般不代理这些非 /chat/completions 端点，
// 误判会白费一次请求，因此命中失败即静默回退到通用后端。

const SEARCH_TIMEOUT_MS = 20_000
const MAX_BODY_BYTES = 1024 * 1024

export type NativeSearchVendor = 'zhipu' | 'moonshot'

export interface NativeSearchOutcome {
  /** 未命中任何厂商，或未启用；调用方应直接走通用后端。 */
  vendor: NativeSearchVendor | null
  result?: ToolResult
  /** 命中厂商但请求失败时的原因，用于在回退结果里追加一行说明。 */
  failure?: string
}

function dispatcherInit(): Record<string, unknown> {
  const opts = getFetchOptions()
  return opts ? (opts as unknown as Record<string, unknown>) : {}
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase()
  } catch {
    return ''
  }
}


export function detectVendor(baseUrl: string): NativeSearchVendor | null {
  const host = hostOf(baseUrl)
  if (!host) return null
  if (host === 'open.bigmodel.cn' || host.endsWith('.bigmodel.cn')) return 'zhipu'
  if (host === 'api.moonshot.cn' || host === 'api.moonshot.ai') return 'moonshot'
  return null
}

async function postJson(
  url: string,
  apiKey: string,
  body: unknown,
  signal: AbortSignal
): Promise<{ ok: boolean; status: number; text: string }> {
  const guard = await guardOutboundUrl(url)
  if (!guard.ok || !guard.url) throw new Error(guard.error ?? 'URL 不安全')

  const res = await fetch(guard.url.toString(), {
    method: 'POST',
    redirect: 'follow',
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(body),
    ...dispatcherInit()
  })
  return { ok: res.ok, status: res.status, text: await readLimited(res) }
}

async function readLimited(res: Response): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return await res.text()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      total += value.byteLength
      if (total >= MAX_BODY_BYTES) {
        void reader.cancel()
        break
      }
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8')
}

const ZHIPU_SEARCH_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/web_search'

interface ZhipuItem {
  title?: unknown
  link?: unknown
  content?: unknown
  publish_date?: unknown
  media?: unknown
}


export function parseZhipuJson(json: unknown, limit: number): string[] {
  const arr = (json as { search_result?: unknown })?.search_result
  if (!Array.isArray(arr)) return []
  const out: string[] = []
  for (const raw of arr.slice(0, limit)) {
    const it = raw as ZhipuItem
    const title = typeof it.title === 'string' ? it.title.trim() : ''
    const link = typeof it.link === 'string' ? it.link.trim() : ''
    if (!title && !link) continue
    const snippet = typeof it.content === 'string' ? it.content.trim().replace(/\s+/g, ' ') : ''
    const date = typeof it.publish_date === 'string' ? it.publish_date.trim() : ''
    const media = typeof it.media === 'string' ? it.media.trim() : ''
    const meta = [media, date].filter(Boolean).join(' · ')
    out.push([title || link, link, meta, snippet].filter(Boolean).join('\n   '))
  }
  return out
}

export async function searchZhipu(
  query: string,
  limit: number,
  apiKey: string,
  signal: AbortSignal
): Promise<ToolResult> {
  const res = await postJson(
    ZHIPU_SEARCH_ENDPOINT,
    apiKey,
    { search_engine: 'search_std', search_query: query, count: limit, content_size: 'medium' },
    signal
  )
  if (!res.ok) throw new Error(`智谱 web_search HTTP ${res.status}：${res.text.slice(0, 300)}`)

  let json: unknown
  try {
    json = JSON.parse(res.text)
  } catch {
    throw new Error(`智谱 web_search 返回非 JSON 响应（HTTP ${res.status}）`)
  }
  const items = parseZhipuJson(json, limit)
  if (items.length === 0) throw new Error('智谱 web_search 未返回可解析结果')

  const body = items.map((s, i) => `${i + 1}. ${s}`).join('\n')
  return { content: `Search results for "${query}"（智谱官方搜索）:\n${body}` }
}

const MOONSHOT_FORMULA_URI = 'moonshot/web-search:latest'


function moonshotFibersUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  const withVersion = /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`
  return `${withVersion}/formulas/${MOONSHOT_FORMULA_URI}/fibers`
}

// Kimi 的 web-search formula 被标记为 protected，结果落在 context.encrypted_output，
// 是一段 ----MOONSHOT ENCRYPTED BEGIN---- 包裹的密文，只有 Moonshot 自家模型能解密。
// 因此这条通道仅在当前对话模型就是 Moonshot 时启用。
export async function searchMoonshot(
  query: string,
  apiKey: string,
  baseUrl: string,
  signal: AbortSignal
): Promise<ToolResult> {
  const res = await postJson(
    moonshotFibersUrl(baseUrl),
    apiKey,
    { name: 'web_search', arguments: JSON.stringify({ query }) },
    signal
  )
  if (!res.ok) throw new Error(`Kimi web-search HTTP ${res.status}：${res.text.slice(0, 300)}`)

  let json: unknown
  try {
    json = JSON.parse(res.text)
  } catch {
    throw new Error(`Kimi web-search 返回非 JSON 响应（HTTP ${res.status}）`)
  }
  return { content: extractMoonshotOutput(json, query) }
}

export function extractMoonshotOutput(json: unknown, query: string): string {
  const fiber = json as { status?: unknown; context?: { output?: unknown; encrypted_output?: unknown } }
  const status = typeof fiber.status === 'string' ? fiber.status : ''
  if (status && status !== 'succeeded') throw new Error(`Kimi web-search 执行失败：status=${status}`)

  const ctx = fiber.context ?? {}
  const plain = typeof ctx.output === 'string' ? ctx.output : ''
  const encrypted = typeof ctx.encrypted_output === 'string' ? ctx.encrypted_output : ''
  const payload = plain || encrypted
  if (!payload) throw new Error('Kimi web-search 未返回 output')

  // 密文原样透传给模型即可，但要提示它这是搜索结果，避免被当成乱码忽略。
  if (!plain) return `Kimi 官方联网搜索结果（"${query}"，密文由模型自行解密）：\n${payload}`
  return `Search results for "${query}"（Kimi 官方搜索）:\n${payload}`
}

export interface NativeSearchOptions {
  query: string
  limit: number
  profileId: string | null | undefined
  signal?: AbortSignal
}


export async function tryProviderNativeSearch(opts: NativeSearchOptions): Promise<NativeSearchOutcome> {
  const profile = opts.profileId ? getProfileRaw(opts.profileId) : null
  if (!profile?.baseUrl) return { vendor: null }

  const vendor = detectVendor(profile.baseUrl)
  if (!vendor) return { vendor: null }

  const apiKey = getProfileApiKey(profile)
  if (!apiKey) return { vendor: null }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)
  const onAbort = (): void => controller.abort()
  opts.signal?.addEventListener('abort', onAbort)

  try {
    const result =
      vendor === 'zhipu'
        ? await searchZhipu(opts.query, opts.limit, apiKey, controller.signal)
        : await searchMoonshot(opts.query, apiKey, profile.baseUrl, controller.signal)
    return { vendor, result }
  } catch (e) {
    if (opts.signal?.aborted) return { vendor, failure: '已取消' }
    return { vendor, failure: e instanceof Error ? e.message : '厂商官方搜索调用失败' }
  } finally {
    clearTimeout(timeout)
    opts.signal?.removeEventListener('abort', onAbort)
  }
}
