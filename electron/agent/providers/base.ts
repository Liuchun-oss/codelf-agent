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

// 清洗「孤儿」工具调用/结果，保证 tool_use 与 tool_result 严格配对后再发给 Provider。
// - 丢弃 toolCallId 未被任何前置 assistant.toolCalls 声明的孤儿 tool 结果消息；
// - 剔除 assistant.toolCalls 里「后面没有对应 tool 结果」的调用；若某 assistant 的
//   所有调用都无结果，则降级为普通 assistant 文本消息。
// 历史可能因异常中断/旧版持久化损坏而残留孤儿。OpenAI 兼容与 Anthropic 通道都必须
// 在发送前清洗：Anthropic 服务端对此零容忍（400: tool_use ids were found without
// tool_result blocks），OpenAI 侧亦应从源头保证消息序列合规。共享同一份实现避免分叉。
export function sanitizeToolMessages(messages: ChatMessage[]): ChatMessage[] {
  const declaredIds = new Set<string>()
  for (const m of messages) {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      for (const tc of m.toolCalls) declaredIds.add(tc.id)
    }
  }
  const resultIds = new Set<string>()
  for (const m of messages) {
    if (m.role === 'tool' && m.toolCallId) resultIds.add(m.toolCallId)
  }
  const out: ChatMessage[] = []
  for (const m of messages) {
    if (m.role === 'tool') {
      if (!m.toolCallId || !declaredIds.has(m.toolCallId)) continue
      out.push(m)
      continue
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const kept = m.toolCalls.filter((tc) => resultIds.has(tc.id))
      if (kept.length === 0) {
        const { toolCalls: _drop, ...rest } = m
        void _drop
        out.push({ ...rest })
      } else {
        out.push({ ...m, toolCalls: kept })
      }
      continue
    }
    out.push(m)
  }
  return out
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
  
  // 上层会话标识。目前仅 Dify 适配器使用，用于按会话隔离 conversation_id，
  // 支持多会话并发（多标签页/多 session 同时对话时互不串扰）。其他适配器忽略。
  sessionId?: string
  
  promptCacheKey?: string
  
  promptCache?: PromptCacheOptions
  
  thinking?: { type: 'enabled' | 'disabled' }
  
  reasoningEffort?: 'high' | 'max'
  
  // 启用后改走 OpenAI Responses API，并注入 image_generation 托管工具，
  // 让模型可在对话中直接生成图片。
  imageGeneration?: boolean
}


export type StreamChunk =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call_delta'
      index: number
      id?: string
      name?: string
      argumentsDelta?: string
    }
  | {
      // 模型通过 image_generation 托管工具生成的图片。
      // partial=true 为流式中间预览（base64），最终图 partial=false。
      type: 'image'
      base64: string
      mediaType: string
      partial: boolean
      index: number
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

// 基于 baseUrl 拼接 API 端点，保留 baseUrl 已有的路径段。
// 关键点：不能用 new URL('/v1/xxx', base)——绝对路径会丢掉 base 原有路径，
// 导致 GLM(.../api/paas/v4)、DashScope(.../compatible-mode/v1) 等带路径端点被打到不存在的 /v1 上（405）。
// 兼容两种填法：base 仅为根域名时补默认 /v1 前缀；已含路径时直接在其后追加。
export function buildEndpointUrl(baseUrl: string, suffix: string): string {
  const trimmed = normalizeBaseUrl(baseUrl)
  if (!trimmed) return ''
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return ''
  }
  const path = url.pathname.replace(/\/+$/, '')
  const cleanSuffix = suffix.replace(/^\/+/, '')
  url.pathname = path === '' ? `/v1/${cleanSuffix}` : `${path}/${cleanSuffix}`
  return url.href
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
