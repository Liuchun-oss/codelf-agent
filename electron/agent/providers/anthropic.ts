import Anthropic from '@anthropic-ai/sdk'
import type { ProviderProfile } from '@shared/agentTypes'
import { getFetchOptions } from './network'
import {
  BaseProviderAdapter,
  ProviderError,
  sdkErrorToProviderError,
  normalizeBaseUrl,
  endpointNeedsNeutralUa,
  markEndpointNeutralUa,
  NEUTRAL_UA,
  parseDataUrl,
  type ChatMessage,
  type ChatRequest,
  type StreamChunk,
  type ToolDef
} from './base'


const FALLBACK_MAX_TOKENS = 4096

type AnthropicCacheControl = {
  type: 'ephemeral'
  ttl?: '5m' | '1h'
}

type CacheableTextBlock = Anthropic.TextBlockParam & {
  cache_control?: AnthropicCacheControl
}

function makeCacheControl(ttl?: '5m' | '1h'): AnthropicCacheControl {
  return ttl ? { type: 'ephemeral', ttl } : { type: 'ephemeral' }
}

function withCacheControl(block: Anthropic.TextBlockParam, ttl?: '5m' | '1h'): CacheableTextBlock {
  return { ...block, cache_control: makeCacheControl(ttl) }
}

function buildSystemParam(system: string, cache?: ChatRequest['promptCache']): string | CacheableTextBlock[] | undefined {
  if (!system) return undefined
  if (!cache?.enabled || !cache.cacheSystem) return system
  return [withCacheControl({ type: 'text', text: system }, cache.ttl)]
}

function addCacheControlToContent(
  content: Anthropic.MessageParam['content'],
  ttl?: '5m' | '1h'
): Anthropic.MessageParam['content'] {
  if (typeof content === 'string') {
    return content ? [withCacheControl({ type: 'text', text: content }, ttl)] : content
  }
  for (let i = content.length - 1; i >= 0; i -= 1) {
    const block = content[i]
    if (block?.type === 'text') {
      const next = [...content]
      next[i] = withCacheControl(block, ttl) as Anthropic.ContentBlockParam
      return next
    }
  }
  return content
}

function applyMessageCacheControl(msgs: Anthropic.MessageParam[], cache?: ChatRequest['promptCache']): Anthropic.MessageParam[] {
  if (!cache?.enabled || !cache.cacheMessages || msgs.length === 0) return msgs
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const content = msgs[i]?.content
    if (content === undefined) continue
    const nextContent = addCacheControlToContent(content, cache.ttl)
    if (nextContent === content) continue
    const next = [...msgs]
    next[i] = { ...next[i], content: nextContent } as Anthropic.MessageParam
    return next
  }
  return msgs
}

function isPromptCacheCompatibilityError(e: unknown): boolean {
  const status = typeof (e as { status?: unknown })?.status === 'number' ? (e as { status: number }).status : undefined
  if (status !== 400) return false
  const message = e instanceof Error ? e.message.toLowerCase() : String(e).toLowerCase()
  return message.includes('cache_control') || message.includes('prompt caching') || message.includes('beta')
}


function splitSystemAndMessages(messages: ChatMessage[]): {
  system: string
  msgs: Anthropic.MessageParam[]
} {
  const systemParts: string[] = []
  const msgs: Anthropic.MessageParam[] = []
  const pendingToolResults: Anthropic.ToolResultBlockParam[] = []

  const flushToolResults = (): void => {
    if (pendingToolResults.length === 0) return
    msgs.push({ role: 'user', content: [...pendingToolResults] })
    pendingToolResults.length = 0
  }

  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content) systemParts.push(m.content)
      continue
    }
    if (m.role === 'tool') {
      // Anthropic 的 tool_result.content 原生支持 text/image block 数组。
      if (m.images?.length) {
        const blocks: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] = []
        if (m.content) blocks.push({ type: 'text', text: m.content })
        for (const img of m.images) {
          const parsed = parseDataUrl(img.dataUrl)
          if (parsed) {
            blocks.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: parsed.mediaType as Anthropic.Base64ImageSource['media_type'],
                data: parsed.base64
              }
            })
          }
        }
        pendingToolResults.push({
          type: 'tool_result',
          tool_use_id: m.toolCallId ?? '',
          content: blocks.length ? blocks : m.content
        })
        continue
      }
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: m.toolCallId ?? '',
        content: m.content
      })
      continue
    }
    flushToolResults()

    if (m.role === 'assistant' && m.toolCalls?.length) {
      const blocks: Anthropic.ContentBlockParam[] = []
      if (m.content?.trim()) blocks.push({ type: 'text', text: m.content })
      for (const tc of m.toolCalls) {
        let input: Record<string, unknown> = {}
        try {
          const parsed = JSON.parse(tc.arguments || '{}') as unknown
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            input = parsed as Record<string, unknown>
          }
        } catch {
          
        }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input })
      }
      msgs.push({ role: 'assistant', content: blocks })
      continue
    }

    if (m.role === 'assistant') {
      msgs.push({ role: 'assistant', content: m.content })
      continue
    }
    
    if (m.images?.length) {
      const blocks: Anthropic.ContentBlockParam[] = []
      for (const img of m.images) {
        const parsed = parseDataUrl(img.dataUrl)
        if (parsed) {
          blocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: parsed.mediaType as Anthropic.Base64ImageSource['media_type'],
              data: parsed.base64
            }
          })
        }
      }
      if (m.content) blocks.push({ type: 'text', text: m.content })
      msgs.push({ role: 'user', content: blocks.length ? blocks : m.content })
      continue
    }
    msgs.push({ role: 'user', content: m.content })
  }
  flushToolResults()
  return { system: systemParts.join('\n\n'), msgs }
}

function toAnthropicTools(tools: ToolDef[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Tool['input_schema']
  }))
}


export class AnthropicAdapter extends BaseProviderAdapter {
  private client: Anthropic
  private fallbackMaxTokens: number
  // 记录该端点是否需要中性 UA（被网关按 SDK UA 拦截过 403），跨请求保持。
  private uaState: { neutralUa: boolean; baseUrl: string } = { neutralUa: false, baseUrl: '' }

  constructor(profile: ProviderProfile, apiKey: string | null) {
    super()
    if (!apiKey) {
      throw new ProviderError('provider_auth', '未配置 API Key')
    }
    this.client = new Anthropic({
      apiKey,
      baseURL: normalizeBaseUrl(profile.baseUrl),
      timeout: profile.timeoutMs,
      maxRetries: 2,
      ...(getFetchOptions() ? { fetchOptions: getFetchOptions() } : {})
    })
    this.fallbackMaxTokens = profile.maxOutputTokens ?? FALLBACK_MAX_TOKENS
    // 进程内若已探测过该端点需要中性 UA，直接沿用，避免每轮提问重复 403 探测。
    this.uaState.baseUrl = profile.baseUrl
    this.uaState.neutralUa = endpointNeedsNeutralUa(profile.baseUrl)
  }

  async *streamChat(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamChunk, void, unknown> {
    const { system, msgs } = splitSystemAndMessages(req.messages)
    const createStream = async (cache?: ChatRequest['promptCache']): Promise<AsyncIterable<Anthropic.RawMessageStreamEvent>> => {
      const systemParam = buildSystemParam(system, cache)
      const requestMsgs = applyMessageCacheControl(msgs, cache)
      return this.client.messages.create(
        {
          model: req.model,
          max_tokens: req.maxOutputTokens ?? this.fallbackMaxTokens,
          stream: true,
          ...(systemParam ? { system: systemParam } : {}),
          ...(typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
          ...(req.tools?.length ? { tools: toAnthropicTools(req.tools) } : {}),
          messages: requestMsgs
        },
        { signal, ...(this.uaState.neutralUa ? { headers: { 'User-Agent': NEUTRAL_UA } } : {}) }
      )
    }

    let stream: AsyncIterable<Anthropic.RawMessageStreamEvent>
    try {
      stream = await createStream(req.promptCache)
    } catch (e) {
      // 端点按 SDK UA 拦截返回 403 时，改用中性 UA 重试一次并记住。
      if (!this.uaState.neutralUa && (e as { status?: unknown })?.status === 403) {
        this.uaState.neutralUa = true
        markEndpointNeutralUa(this.uaState.baseUrl)
        try {
          stream = await createStream(req.promptCache)
        } catch (retryErr) {
          throw sdkErrorToProviderError(retryErr)
        }
      } else if (req.promptCache?.enabled && isPromptCacheCompatibilityError(e)) {
        try {
          stream = await createStream(undefined)
        } catch (fallbackError) {
          const originalError = sdkErrorToProviderError(e)
          const normalizedFallback = sdkErrorToProviderError(fallbackError)
          throw new ProviderError(
            normalizedFallback.code,
            `${normalizedFallback.message}（禁用 prompt cache 回退也失败；原始 prompt cache 错误：${originalError.message}）`,
            normalizedFallback.httpStatus,
            originalError
          )
        }
      } else {
        throw sdkErrorToProviderError(e)
      }
    }

    try {
      for await (const event of stream) {
        switch (event.type) {
          case 'message_start': {
            const u = event.message.usage
            if (u) {
              const usageWithCache = u as typeof u & {
                cache_read_input_tokens?: unknown
                cache_creation_input_tokens?: unknown
              }
              const cacheReadInputTokens =
                typeof usageWithCache.cache_read_input_tokens === 'number' ? usageWithCache.cache_read_input_tokens : undefined
              const cacheCreationInputTokens =
                typeof usageWithCache.cache_creation_input_tokens === 'number' ? usageWithCache.cache_creation_input_tokens : undefined
              yield {
                type: 'usage',
                inputTokens: u.input_tokens,
                outputTokens: u.output_tokens,
                cacheReadInputTokens,
                cacheCreationInputTokens
              }
            }
            break
          }
          case 'content_block_start': {
            if (event.content_block.type === 'tool_use') {
              yield {
                type: 'tool_call_delta',
                index: event.index,
                id: event.content_block.id,
                name: event.content_block.name
              }
            }
            break
          }
          case 'content_block_delta': {
            const d = event.delta
            if (d.type === 'text_delta') {
              yield { type: 'text', text: d.text }
            } else if (d.type === 'thinking_delta') {
              yield { type: 'thinking', text: d.thinking }
            } else if (d.type === 'input_json_delta') {
              yield { type: 'tool_call_delta', index: event.index, argumentsDelta: d.partial_json }
            }
            break
          }
          case 'message_delta': {
            if (event.usage) yield { type: 'usage', outputTokens: event.usage.output_tokens }
            if (event.delta.stop_reason) yield { type: 'done', finishReason: event.delta.stop_reason }
            break
          }
          default:
            break
        }
      }
    } catch (e) {
      throw sdkErrorToProviderError(e)
    }
  }
}
