import type { AgentErrorCode } from '@shared/agentTypes'



export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'


export interface ToolCallRequest {
  id: string
  name: string
  
  arguments: string
}

export interface ChatMessage {
  role: ChatRole
  content: string
  
  toolCalls?: ToolCallRequest[]
  
  toolCallId?: string
  
  images?: { dataUrl: string }[]
  
  reasoningContent?: string
}


export function parseDataUrl(dataUrl: string): { mediaType: string; base64: string } | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl)
  if (!m) return null
  return { mediaType: m[1], base64: m[2] }
}


export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface PromptCacheOptions {
  enabled: boolean
  
  ttl?: '5m' | '1h'
  
  cacheSystem?: boolean
  
  cacheMessages?: boolean
}

export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  maxOutputTokens?: number
  temperature?: number
  tools?: ToolDef[]
  
  promptCacheKey?: string
  
  promptCache?: PromptCacheOptions
  
  thinking?: { type: 'enabled' | 'disabled' }
  
  reasoningEffort?: 'high' | 'max'
}


export type StreamChunk =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | {
      type: 'tool_call_delta'
      index: number
      id?: string
      name?: string
      argumentsDelta?: string
    }
  | {
      type: 'usage'
      
      inputTokens?: number
      outputTokens?: number
      cacheReadInputTokens?: number
      cacheCreationInputTokens?: number
    }
  | { type: 'done'; finishReason?: string }

export abstract class BaseProviderAdapter {
  
  abstract streamChat(
    req: ChatRequest,
    signal?: AbortSignal
  ): AsyncGenerator<StreamChunk, void, unknown>
}


export class ProviderError extends Error {
  readonly code: AgentErrorCode
  readonly httpStatus?: number
  readonly retryable = false

  constructor(code: AgentErrorCode, message: string, httpStatus?: number, cause?: unknown) {
    super(message)
    this.name = 'ProviderError'
    this.code = code
    this.httpStatus = httpStatus
    if (cause !== undefined) {
      ;(this as Error & { cause?: unknown }).cause = cause
    }
  }
}


export function mapHttpStatusToError(status: number, detail?: string): ProviderError {
  if (status === 401 || status === 403) {
    return new ProviderError('provider_auth', 'API Key 无效或无权访问', status)
  }
  if (status === 404) {
    return new ProviderError('provider_not_found', 'Base URL 错误，或模型/Deployment 不存在', status)
  }
  if (status === 429) {
    return new ProviderError('provider_rate_limit', '配额不足或被限流（429）', status)
  }
  if (status >= 500) {
    return new ProviderError('provider_server', `服务端错误（${status}）`, status)
  }
  return new ProviderError('unknown', detail ? `请求失败（${status}）：${detail}` : `请求失败（${status}）`, status)
}

export function isAbortError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false
  const name = (e as { name?: unknown }).name
  return name === 'AbortError' || name === 'APIUserAbortError'
}

/** 判断是否为网络瞬断类错误，可安全重试 */
export function isTransientNetworkError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false
  if (isAbortError(e)) return false
  if (e instanceof ProviderError) {
    return e.code === 'network' || e.code === 'provider_timeout'
  }
  const code = (e as { code?: unknown })?.code
  if (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'EAI_AGAIN' ||
    code === 'EPIPE' ||
    code === 'UND_ERR_SOCKET'
  ) return true
  const msg = e instanceof Error ? e.message.toLowerCase() : ''
  if (
    msg.includes('fetch failed') ||
    msg.includes('socket hang up') ||
    msg.includes('other side closed') ||
    msg.includes('network socket disconnected')
  ) return true
  const cause = (e as { cause?: unknown })?.cause
  if (cause && cause !== e) return isTransientNetworkError(cause)
  return false
}


export function networkErrorToProviderError(e: unknown): ProviderError {
  const code = (e as { code?: unknown })?.code
  if (
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'EAI_AGAIN'
  ) {
    return new ProviderError('network', '网络不可达；请检查 Base URL、代理或防火墙设置')
  }
  const msg = e instanceof Error ? e.message : '未知错误'
  return new ProviderError('unknown', msg)
}


export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

// 进程级缓存：记住哪些端点（按 baseUrl）会因 SDK 默认 User-Agent 被网关
// （如 Cloudflare 前置的 new-api）拦截返回 403，需要改用中性 UA。一旦探测到，
// 整个进程生命周期内对该端点直接用中性 UA，避免每轮提问都先吃一次 403 再重试。
export const NEUTRAL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
const neutralUaEndpoints = new Set<string>()

export function endpointNeedsNeutralUa(baseUrl: string): boolean {
  return neutralUaEndpoints.has(normalizeBaseUrl(baseUrl))
}

export function markEndpointNeutralUa(baseUrl: string): void {
  neutralUaEndpoints.add(normalizeBaseUrl(baseUrl))
}


export function sdkErrorToProviderError(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e
  if (isAbortError(e)) return new ProviderError('cancelled', '已取消')

  const status = (e as { status?: unknown })?.status
  if (typeof status === 'number') {
    return mapHttpStatusToError(status, e instanceof Error ? e.message : undefined)
  }

  const name = (e as { name?: unknown })?.name
  if (name === 'APIConnectionTimeoutError') {
    return new ProviderError('provider_timeout', '请求超时；可在设置中调大超时时间')
  }
  const cause = (e as { cause?: unknown })?.cause
  return networkErrorToProviderError(cause ?? e)
}
