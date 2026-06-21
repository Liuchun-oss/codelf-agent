import { z } from 'zod'
import type { Tool, ToolResult } from './types'
import { guardOutboundUrl } from './ssrfGuard'
import { WEB_SEARCH_DESCRIPTION, WEB_SEARCH_NAME } from '../prompts/tools/webSearch'
import { getWebSearchSettings } from '../settings/agentSettingsStore'
import { getSecret, hasSecret } from '../../ipc/secrets'
import { getFetchOptions } from '../providers/network'
import type { IqsEngineType, WebSearchProvider } from '@shared/agentSettings'
import { userAgent } from '@shared/appConfig'

const SEARCH_TIMEOUT_MS = 20_000
const MAX_BODY_BYTES = 1024 * 1024
const MAX_RESULTS = 10


export const WEB_SEARCH_IQS_KEY_REF = 'websearch:aliyun-iqs'
export const WEB_SEARCH_BRAVE_KEY_REF = 'websearch:brave'

const IQS_ENDPOINT = 'https://cloud-iqs.aliyuncs.com/search/unified'
const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'

const webSearchSchema = z.object({
  query: z.string().min(1).describe('Search query. Include year/version when freshness matters.'),
  limit: z.number().int().min(1).max(MAX_RESULTS).optional().describe('Maximum number of results to return')
})

type WebSearchInput = z.infer<typeof webSearchSchema>

interface SearchResult {
  title: string
  url: string
  snippet: string
}


export type ResolvedWebSearchProvider = Exclude<WebSearchProvider, 'auto'>

interface SecretProbe {
  hasIqsKey: boolean
  hasBraveKey: boolean
}


export function resolveWebSearchProvider(
  provider: WebSearchProvider,
  secrets: SecretProbe
): ResolvedWebSearchProvider {
  if (provider !== 'auto') return provider
  if (secrets.hasIqsKey) return 'aliyun-iqs'
  if (secrets.hasBraveKey) return 'brave'
  return 'duckduckgo'
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, '/')
}

function stripTags(value: string): string {
  return decodeHtml(value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trim())
}

function normalizeDuckDuckGoUrl(raw: string): string {
  const decoded = decodeHtml(raw)
  try {
    const url = new URL(decoded, 'https://duckduckgo.com')
    const uddg = url.searchParams.get('uddg')
    if (uddg) return decodeURIComponent(uddg)
    return url.toString()
  } catch {
    return decoded
  }
}

export function parseDuckDuckGoHtml(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = []
  const resultRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  while ((match = resultRe.exec(html)) !== null && results.length < limit) {
    const title = stripTags(match[2])
    const url = normalizeDuckDuckGoUrl(match[1])
    const snippet = stripTags(match[3])
    if (title && url) results.push({ title, url, snippet })
  }

  if (results.length > 0) return results

  const looseRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  while ((match = looseRe.exec(html)) !== null && results.length < limit) {
    const title = stripTags(match[2])
    const url = normalizeDuckDuckGoUrl(match[1])
    if (title && url) results.push({ title, url, snippet: '' })
  }
  return results
}


export function parseBraveJson(json: unknown, limit: number): SearchResult[] {
  const results: SearchResult[] = []
  const web = (json as { web?: { results?: unknown[] } } | null)?.web
  const items = Array.isArray(web?.results) ? (web?.results as Record<string, unknown>[]) : []
  for (const item of items) {
    if (results.length >= limit) break
    const title = typeof item.title === 'string' ? stripTags(item.title) : ''
    const url = typeof item.url === 'string' ? item.url : ''
    const snippet = typeof item.description === 'string' ? stripTags(item.description) : ''
    if (title && url) results.push({ title, url, snippet })
  }
  return results
}


export function parseIqsJson(json: unknown, limit: number): SearchResult[] {
  const results: SearchResult[] = []
  const items = (json as { pageItems?: unknown[] } | null)?.pageItems
  const list = Array.isArray(items) ? (items as Record<string, unknown>[]) : []
  for (const item of list) {
    if (results.length >= limit) break
    const title = typeof item.title === 'string' ? stripTags(item.title) : ''
    const url = typeof item.link === 'string' ? item.link : ''
    const snippet = typeof item.snippet === 'string' ? stripTags(item.snippet) : ''
    if (title && url) results.push({ title, url, snippet })
  }
  return results
}

async function readLimitedText(res: Response): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader()
  if (!reader) return { text: '', truncated: false }
  const chunks: Uint8Array[] = []
  let received = 0
  let truncated = false
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    chunks.push(value)
    received += value.length
    if (received >= MAX_BODY_BYTES) {
      truncated = true
      await reader.cancel().catch(() => {})
      break
    }
  }
  return { text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8'), truncated }
}

function formatResults(query: string, results: SearchResult[], truncated: boolean): ToolResult {
  const lines = results.flatMap((r, i) => [`${i + 1}. ${r.title}`, `   ${r.url}`, r.snippet ? `   ${r.snippet}` : ''])
  return { content: `Search results for "${query}":\n${lines.filter(Boolean).join('\n')}`, truncated }
}


function dispatcherInit(): Record<string, unknown> {
  const opts = getFetchOptions()
  return opts ? (opts as unknown as Record<string, unknown>) : {}
}

async function searchDuckDuckGo(
  query: string,
  limit: number,
  signal: AbortSignal
): Promise<ToolResult> {
  const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const guard = await guardOutboundUrl(searchUrl)
  if (!guard.ok || !guard.url) return { content: `已拒绝搜索：${guard.error ?? 'URL 不安全'}`, isError: true }

  const res = await fetch(guard.url.toString(), {
    method: 'GET',
    redirect: 'follow',
    signal,
    headers: {
      'User-Agent': userAgent('WebSearch'),
      Accept: 'text/html,application/xhtml+xml'
    },
    ...dispatcherInit()
  })
  const { text, truncated } = await readLimitedText(res)
  const results = parseDuckDuckGoHtml(text, limit)
  if (results.length === 0) {
    return { content: `No web search results parsed for "${query}". HTTP ${res.status}.`, isError: !res.ok, truncated }
  }
  return formatResults(query, results, truncated)
}

async function searchBrave(
  query: string,
  limit: number,
  apiKey: string,
  signal: AbortSignal
): Promise<ToolResult> {
  const url = `${BRAVE_ENDPOINT}?q=${encodeURIComponent(query)}&count=${limit}`
  const guard = await guardOutboundUrl(url)
  if (!guard.ok || !guard.url) return { content: `已拒绝搜索：${guard.error ?? 'URL 不安全'}`, isError: true }

  const res = await fetch(guard.url.toString(), {
    method: 'GET',
    redirect: 'follow',
    signal,
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': apiKey
    },
    ...dispatcherInit()
  })
  const { text, truncated } = await readLimitedText(res)
  if (!res.ok) {
    return { content: `Brave 搜索失败（HTTP ${res.status}）：${text.slice(0, 500)}`, isError: true, truncated }
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { content: `Brave 返回非 JSON 响应（HTTP ${res.status}）`, isError: true, truncated }
  }
  const results = parseBraveJson(json, limit)
  if (results.length === 0) return { content: `No web search results parsed for "${query}".`, truncated }
  return formatResults(query, results, truncated)
}

async function searchIqs(
  query: string,
  limit: number,
  apiKey: string,
  engineType: IqsEngineType,
  signal: AbortSignal
): Promise<ToolResult> {
  const guard = await guardOutboundUrl(IQS_ENDPOINT)
  if (!guard.ok || !guard.url) return { content: `已拒绝搜索：${guard.error ?? 'URL 不安全'}`, isError: true }

  const res = await fetch(guard.url.toString(), {
    method: 'POST',
    redirect: 'follow',
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      query,
      engineType,
      contents: { rerankScore: true },
      advancedParams: { numResults: String(limit) }
    }),
    ...dispatcherInit()
  })
  const { text, truncated } = await readLimitedText(res)
  if (!res.ok) {
    return { content: `阿里云 IQS 搜索失败（HTTP ${res.status}）：${text.slice(0, 500)}`, isError: true, truncated }
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { content: `阿里云 IQS 返回非 JSON 响应（HTTP ${res.status}）`, isError: true, truncated }
  }
  const results = parseIqsJson(json, limit)
  if (results.length === 0) return { content: `No web search results parsed for "${query}".`, truncated }
  return formatResults(query, results, truncated)
}

export const webSearchTool: Tool<WebSearchInput> = {
  name: WEB_SEARCH_NAME,
  description: WEB_SEARCH_DESCRIPTION,
  schema: webSearchSchema,
  readOnly: true,
  concurrencySafe: false,
  async execute(input, ctx): Promise<ToolResult> {
    const limit = input.limit ?? 5
    const settings = getWebSearchSettings()
    const provider = resolveWebSearchProvider(settings.provider, {
      hasIqsKey: hasSecret(WEB_SEARCH_IQS_KEY_REF),
      hasBraveKey: hasSecret(WEB_SEARCH_BRAVE_KEY_REF)
    })

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)
    const onAbort = (): void => controller.abort()
    ctx.signal?.addEventListener('abort', onAbort)

    try {
      if (provider === 'aliyun-iqs') {
        const key = getSecret(WEB_SEARCH_IQS_KEY_REF)
        if (!key) return { content: '阿里云 IQS 未配置 API Key，请在设置 → 联网搜索 中填写。', isError: true }
        return await searchIqs(input.query, limit, key, settings.iqsEngineType, controller.signal)
      }
      if (provider === 'brave') {
        const key = getSecret(WEB_SEARCH_BRAVE_KEY_REF)
        if (!key) return { content: 'Brave 未配置 API Key，请在设置 → 联网搜索 中填写。', isError: true }
        return await searchBrave(input.query, limit, key, controller.signal)
      }
      return await searchDuckDuckGo(input.query, limit, controller.signal)
    } catch (e) {
      if (controller.signal.aborted) return { content: '请求已取消或超时', isError: true }
      return { content: e instanceof Error ? e.message : '搜索失败', isError: true }
    } finally {
      clearTimeout(timeout)
      ctx.signal?.removeEventListener('abort', onAbort)
    }
  }
}
