import OpenAI from 'openai'
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
  type ChatMessage,
  type ChatRequest,
  type StreamChunk,
  type ToolDef
} from './base'

type OpenAIMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam
type OpenAITool = OpenAI.Chat.Completions.ChatCompletionTool

function toOpenAIMessages(
  messages: ChatMessage[],
  opts?: { dropReasoningContent?: boolean }
): OpenAIMessage[] {
  const out: OpenAIMessage[] = []
  // OpenAI 要求同一批 tool 结果消息必须连续，中间不能插别的角色。
  // 因此 tool 消息携带的图片先缓存，等这批连续的 tool 消息结束后，
  // 再作为一条合成 user 消息统一插入。
  let pendingToolImages: { dataUrl: string }[] = []
  const flushToolImages = (): void => {
    if (pendingToolImages.length === 0) return
    const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
      { type: 'text', text: '上一批工具返回的图片：' }
    ]
    for (const img of pendingToolImages) {
      parts.push({ type: 'image_url', image_url: { url: img.dataUrl } })
    }
    out.push({ role: 'user', content: parts })
    pendingToolImages = []
  }

  for (const m of messages) {
    if (m.role === 'tool') {
      out.push({ role: 'tool', content: m.content, tool_call_id: m.toolCallId ?? '' })
      if (m.images?.length) pendingToolImages.push(...m.images)
      continue
    }
    // 离开 tool 消息序列前，先把缓存的图片刷成一条 user 消息。
    flushToolImages()
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const msg: OpenAIMessage = {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments }
        }))
      }

      if (m.reasoningContent && !opts?.dropReasoningContent) {
        ;(msg as unknown as Record<string, unknown>).reasoning_content = m.reasoningContent
      }
      out.push(msg)
      continue
    }
    if (m.role === 'assistant') {
      out.push({ role: 'assistant', content: m.content })
      continue
    }
    if (m.role === 'system') {
      out.push({ role: 'system', content: m.content })
      continue
    }

    if (m.images?.length) {
      const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = []
      if (m.content) parts.push({ type: 'text', text: m.content })
      for (const img of m.images) {
        parts.push({ type: 'image_url', image_url: { url: img.dataUrl } })
      }
      out.push({ role: 'user', content: parts })
      continue
    }
    out.push({ role: 'user', content: m.content })
  }
  // 序列以 tool 消息结尾时，刷出尾部缓存的图片。
  flushToolImages()
  return out
}

function toOpenAITools(tools: ToolDef[]): OpenAITool[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters as Record<string, unknown>
    }
  }))
}

// 判断某个 400 错误是否因为端点不支持图片（image_url）内容块。
// 文本模型（如 deepseek-v4）会返回类似：
//   "Failed to deserialize the JSON body ... unknown variant `image_url`, expected `text`"
function isImageUnsupportedError(e: unknown): boolean {
  const status = (e as { status?: unknown })?.status
  if (status !== undefined && status !== 400) return false
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
  const lower = msg.toLowerCase()
  return lower.includes('image_url') || (lower.includes('image') && lower.includes('expected') && lower.includes('text'))
}

// 剥离所有消息中的图片，避免把 image_url 发给不支持视觉的端点。
// 返回是否确实剥离了内容（用于决定是否值得重试）。
function stripImagesFromMessages(messages: ChatMessage[]): { messages: ChatMessage[]; stripped: boolean } {
  let stripped = false
  const next = messages.map((m) => {
    if (!m.images?.length) return m
    stripped = true
    const note = `（图片已省略：当前模型不支持图片输入，共 ${m.images.length} 张）`
    const content = m.content ? `${m.content}\n${note}` : note
    const { images: _drop, ...rest } = m
    return { ...rest, content }
  })
  return { messages: next, stripped }
}


function isForbiddenError(e: unknown): boolean {
  return (e as { status?: unknown })?.status === 403
}

// 手动 SSE 解析器：绕过 openai SDK 的内置流解析，避免与某些
// new-api/new-api 类中转站（如 jojocode）的 SSE 格式不兼容导致 0 chunk 产出。
function makeSSEIterable(
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk> {
  const decoder = new TextDecoder()
  let buf = ''

  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<OpenAI.Chat.Completions.ChatCompletionChunk>> {
          while (true) {
            const { done, value } = await reader.read()
            if (done) return { done: true, value: undefined as unknown as OpenAI.Chat.Completions.ChatCompletionChunk }

            buf += decoder.decode(value, { stream: true })
            const lines = buf.split('\n')
            buf = lines.pop() || ''

            for (const line of lines) {
              const trimmed = line.trim()
              if (!trimmed.startsWith('data:')) continue
              const data = trimmed.slice(5).trim()
              if (!data || data === '[DONE]') continue
              try {
                const chunk = JSON.parse(data) as OpenAI.Chat.Completions.ChatCompletionChunk
                return { done: false, value: chunk }
              } catch { /* skip unparseable lines */ }
            }
          }
        }
      }
    }
  }
}

export async function* streamChatViaOpenAI(
  client: OpenAI,
  req: ChatRequest,
  signal?: AbortSignal,
  visionState?: { imageUnsupported: boolean },
  opts?: { dropReasoningContent?: boolean },
  uaState?: { neutralUa: boolean; baseUrl?: string }
): AsyncGenerator<StreamChunk, void, unknown> {
  const thinkingEnabled = req.thinking?.type === 'enabled'
  const apiKey = (client as Record<string, unknown>).apiKey as string
  const rawBaseUrl = ((client as Record<string, unknown>)._options as Record<string, unknown> | undefined)
    ?.baseURL as string || (client as Record<string, unknown>).baseURL as string || ''
  const fetchUrl = rawBaseUrl ? new URL('/v1/chat/completions', rawBaseUrl).href : ''

  const doRequest = async (
    messages: ChatMessage[],
    forceNeutralUa: boolean
  ): Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    }
    if (forceNeutralUa) headers['User-Agent'] = NEUTRAL_UA

    const body: Record<string, unknown> = {
      model: req.model,
      messages: toOpenAIMessages(messages, opts),
      stream: true,
      stream_options: { include_usage: true },
    }
    if (typeof req.maxOutputTokens === 'number') body['max_tokens'] = req.maxOutputTokens
    if (typeof req.temperature === 'number' && !thinkingEnabled) body['temperature'] = req.temperature
    if (req.tools?.length) { body['tools'] = toOpenAITools(req.tools); body['tool_choice'] = 'auto' }
    if (req.promptCacheKey) body['prompt_cache_key'] = req.promptCacheKey
    if (req.thinking) body['thinking'] = req.thinking
    if (req.reasoningEffort) body['reasoning_effort'] = req.reasoningEffort

    const resp = await fetch(fetchUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    })

    if (!resp.ok) {
      const errStatus = resp.status
      const errText = await resp.text().catch(() => '')
      const err: Error & { status?: number } = new Error(`HTTP ${errStatus}: ${errText}`)
      err.status = errStatus
      throw err
    }

    const reader = resp.body?.getReader()
    if (!reader) throw new Error('No response body')
    return makeSSEIterable(reader)
  }

  // 默认沿用 SDK 原生 UA，行为与之前完全一致。
  // 仅当某端点（如 Cloudflare 前置的 new-api）对 SDK UA 返回 403 时，
  // 才自动改用中性 UA 重试一次，并记住该端点后续都用中性 UA，避免反复触发。
  const createStream = async (
    messages: ChatMessage[]
  ): Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>> => {
    try {
      return await doRequest(messages, uaState?.neutralUa ?? false)
    } catch (e) {
      if (uaState && !uaState.neutralUa && isForbiddenError(e)) {
        uaState.neutralUa = true
        if (uaState.baseUrl) markEndpointNeutralUa(uaState.baseUrl)
        return await doRequest(messages, true)
      }
      throw e
    }
  }

  // 若该端点此前已被证实不支持图片，主动剥图，避免每轮都先 400 再重试。
  const initialMessages = visionState?.imageUnsupported
    ? stripImagesFromMessages(req.messages).messages
    : req.messages

  let stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>
  try {
    stream = await createStream(initialMessages)
  } catch (e) {
    // 端点不支持图片（image_url）时，剥离图片降级为纯文本重试一次。
    // 这能自愈历史里已混入图片块、导致每轮都 400 的死锁会话。
    if (isImageUnsupportedError(e)) {
      const { messages, stripped } = stripImagesFromMessages(req.messages)
      if (stripped) {
        // 记住该端点不支持图片，后续请求直接剥图。
        if (visionState) visionState.imageUnsupported = true
        try {
          stream = await createStream(messages)
        } catch (retryErr) {
          throw sdkErrorToProviderError(retryErr)
        }
      } else {
        throw sdkErrorToProviderError(e)
      }
    } else {
      throw sdkErrorToProviderError(e)
    }
  }

  try {
    for await (const chunk of stream) {
      const choice = chunk.choices?.[0]
      const delta = choice?.delta

      const extended = delta as {
        reasoning_content?: unknown
        reasoning?: unknown
        thinking?: unknown
      }


      const reasoning =
        typeof extended?.reasoning_content === 'string'
          ? extended.reasoning_content
          : typeof extended?.reasoning === 'string'
            ? extended.reasoning
            : typeof extended?.thinking === 'string'
              ? extended.thinking
              : ''
      if (reasoning.length > 0) {
        yield { type: 'thinking', text: reasoning }
      }

      if (typeof delta?.content === 'string' && delta.content.length > 0) {
        yield { type: 'text', text: delta.content }
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          yield {
            type: 'tool_call_delta',
            index: tc.index,
            id: tc.id,
            name: tc.function?.name,
            argumentsDelta: tc.function?.arguments
          }
        }
      }

      if (chunk.usage) {
        const usageWithCache = chunk.usage as typeof chunk.usage & {
          prompt_tokens_details?: { cached_tokens?: unknown }
          prompt_cache_hit_tokens?: unknown
          prompt_cache_miss_tokens?: unknown
        }
        const promptTokens = chunk.usage.prompt_tokens

        const dsHit =
          typeof usageWithCache.prompt_cache_hit_tokens === 'number'
            ? usageWithCache.prompt_cache_hit_tokens
            : undefined
        const dsMiss =
          typeof usageWithCache.prompt_cache_miss_tokens === 'number'
            ? usageWithCache.prompt_cache_miss_tokens
            : undefined
        if (dsHit !== undefined || dsMiss !== undefined) {
          const cacheReadInputTokens = dsHit ?? 0
          const uncachedInput = dsMiss ?? Math.max(0, promptTokens - cacheReadInputTokens)
          yield {
            type: 'usage',
            inputTokens: uncachedInput,
            outputTokens: chunk.usage.completion_tokens,
            cacheReadInputTokens
          }
        } else {
          const cachedTokens = usageWithCache.prompt_tokens_details?.cached_tokens
          const cacheReadInputTokens = typeof cachedTokens === 'number' ? cachedTokens : undefined
          yield {
            type: 'usage',
            inputTokens: cacheReadInputTokens === undefined ? promptTokens : Math.max(0, promptTokens - cacheReadInputTokens),
            outputTokens: chunk.usage.completion_tokens,
            cacheReadInputTokens
          }
        }
      }

      if (choice?.finish_reason) {
        yield { type: 'done', finishReason: choice.finish_reason }
      }
    }
  } catch (e) {
    throw sdkErrorToProviderError(e)
  }
}


export class OpenAIAdapter extends BaseProviderAdapter {
  protected client: OpenAI
  // 记录该端点是否已被证实不支持图片，跨请求保持，避免反复触发 400。
  protected visionState = { imageUnsupported: false }
  // 记录该端点是否需要中性 UA（被网关按 SDK UA 拦截过 403），跨请求保持。
  protected uaState: { neutralUa: boolean; baseUrl?: string } = { neutralUa: false }
  protected dropReasoningContent = false

  constructor(profile: ProviderProfile, apiKey: string | null, opts?: { allowMissingKey?: boolean }) {
    super()
    if (!apiKey && !opts?.allowMissingKey) {
      throw new ProviderError('provider_auth', '未配置 API Key')
    }
    this.client = new OpenAI({
      apiKey: apiKey || 'no-key',
      baseURL: normalizeBaseUrl(profile.baseUrl),
      timeout: profile.timeoutMs,
      maxRetries: 2,
      ...(getFetchOptions() ? { fetchOptions: getFetchOptions() } : {})
    })
    // 进程内若已探测过该端点需要中性 UA，直接沿用，避免每轮提问重复 403 探测。
    this.uaState.baseUrl = profile.baseUrl
    this.uaState.neutralUa = endpointNeedsNeutralUa(profile.baseUrl)
  }

  streamChat(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamChunk, void, unknown> {
    return streamChatViaOpenAI(this.client, req, signal, this.visionState, {
      dropReasoningContent: this.dropReasoningContent
    }, this.uaState)
  }
}
