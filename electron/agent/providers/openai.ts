import OpenAI from 'openai'
import type { ProviderProfile } from '@shared/agentTypes'
import { getFetchOptions } from './network'
import {
  BaseProviderAdapter,
  ProviderError,
  sdkErrorToProviderError,
  normalizeBaseUrl,
  buildEndpointUrl,
  endpointNeedsNeutralUa,
  markEndpointNeutralUa,
  NEUTRAL_UA,
  sanitizeToolMessages,
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
  // 防御：丢弃"孤儿" tool 消息——即前面没有声明对应 tool_call id 的 assistant。
  // 历史可能因旧版持久化丢失 toolCalls 而损坏，发给严格 Provider（DeepSeek）会整请求报错。
  messages = sanitizeToolMessages(messages)
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
      // Kimi/Moonshot 等严格 Provider 拒绝 content 为空的 assistant 消息
      // （400: the message ... with role 'assistant' must not be empty）。
      // 历史里可能残留「只思考、未输出正文，也无工具调用」的空 assistant 轮次，
      // 这里直接跳过，避免整条请求 400、点「继续」反复失败。OpenAI 官方允许空/ null，
      // 但跳过对纯文本轮次是安全的（不涉及 tool_call 配对）。
      if (!m.content || m.content.trim().length === 0) continue
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

// ---- Responses API（/v1/responses）支持：把通用消息/工具转换为 Responses 输入格式 ----

type RInputItem = Record<string, unknown>

function pushToolImagesAsUser(out: RInputItem[], imgs: { dataUrl: string }[]): void {
  if (imgs.length === 0) return
  const content: RInputItem[] = [{ type: 'input_text', text: '上一批工具返回的图片：' }]
  for (const img of imgs) content.push({ type: 'input_image', image_url: img.dataUrl })
  out.push({ role: 'user', content })
}

// 把通用 ChatMessage[] 转为 Responses API 的 input 数组。
// - assistant 工具调用 → function_call item（call_id/name/arguments）
// - tool 结果 → function_call_output item（call_id/output）
// - 其余 → role 消息，user/带图用 input_text/input_image，assistant 用 output_text
function toResponsesInput(messages: ChatMessage[]): RInputItem[] {
  const out: RInputItem[] = []
  let pendingToolImages: { dataUrl: string }[] = []
  const flush = (): void => {
    pushToolImagesAsUser(out, pendingToolImages)
    pendingToolImages = []
  }
  for (const m of messages) {
    if (m.role === 'tool') {
      out.push({ type: 'function_call_output', call_id: m.toolCallId ?? '', output: m.content })
      if (m.images?.length) pendingToolImages.push(...m.images)
      continue
    }
    flush()
    if (m.role === 'assistant' && m.toolCalls?.length) {
      if (m.content) out.push({ role: 'assistant', content: [{ type: 'output_text', text: m.content }] })
      for (const tc of m.toolCalls) {
        out.push({ type: 'function_call', call_id: tc.id, name: tc.name, arguments: tc.arguments })
      }
      continue
    }
    if (m.role === 'assistant') {
      out.push({ role: 'assistant', content: [{ type: 'output_text', text: m.content }] })
      continue
    }
    if (m.role === 'system') {
      out.push({ role: 'system', content: [{ type: 'input_text', text: m.content }] })
      continue
    }
    const content: RInputItem[] = []
    if (m.content) content.push({ type: 'input_text', text: m.content })
    for (const img of m.images ?? []) content.push({ type: 'input_image', image_url: img.dataUrl })
    out.push({ role: 'user', content: content.length ? content : [{ type: 'input_text', text: '' }] })
  }
  flush()
  return out
}

function toResponsesTools(tools: ToolDef[] | undefined): RInputItem[] {
  const out: RInputItem[] = [{ type: 'image_generation', partial_images: 2 }]
  for (const t of tools ?? []) {
    out.push({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false })
  }
  return out
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

// 手动 SSE 解析器：使用 Node.js Buffer 做字节级 UTF-8 解码，
// 只对完整行（以 \n 结尾）解码，避免 TextDecoder 流式解码在 Electron 中的中文乱码 bug。
function makeSSEIterable(
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk> {
  let byteBuf = Buffer.alloc(0)
  // 一次 read() 可能携带多条 SSE 事件（中转站常把多个 data: 攒在一个包里下发）。
  // 必须把本批解析出的所有 chunk 排队，next() 逐个返回，否则会丢失除第一条以外的所有事件，
  // 导致 tool_call/思考分片残缺、工具无法执行。
  const pending: OpenAI.Chat.Completions.ChatCompletionChunk[] = []

  // 把一段（含若干完整行的）文本解析为 chunk，依次压入待发队列。
  const drainText = (text: string): void => {
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (!data || data === '[DONE]') continue
      try {
        pending.push(JSON.parse(data) as OpenAI.Chat.Completions.ChatCompletionChunk)
      } catch { /* skip unparseable lines */ }
    }
  }

  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<OpenAI.Chat.Completions.ChatCompletionChunk>> {
          while (true) {
            if (pending.length > 0) {
              return { done: false, value: pending.shift()! }
            }

            const { done, value } = await reader.read()
            if (done) {
              drainText(byteBuf.toString('utf-8'))
              byteBuf = Buffer.alloc(0)
              if (pending.length > 0) {
                return { done: false, value: pending.shift()! }
              }
              return { done: true, value: undefined as unknown as OpenAI.Chat.Completions.ChatCompletionChunk }
            }
            byteBuf = Buffer.concat([byteBuf, Buffer.from(value)])

            let lastNL = -1
            for (let i = byteBuf.length - 1; i >= 0; i--) {
              if (byteBuf[i] === 0x0a) { lastNL = i; break }
            }
            if (lastNL < 0) continue

            const complete = byteBuf.slice(0, lastNL + 1).toString('utf-8')
            byteBuf = byteBuf.slice(lastNL + 1)
            drainText(complete)
          }
        }
      }
    }
  }
}

// 通用 SSE 解析器（Responses API）：与 makeSSEIterable 同样的字节级 UTF-8 解码，
// 但 Responses 事件结构各异，这里只产出已解析的 JSON 对象，事件路由交给调用方。
function makeJsonSSEIterable(
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncIterable<Record<string, unknown>> {
  let byteBuf = Buffer.alloc(0)
  const pending: Record<string, unknown>[] = []
  const drainText = (text: string): void => {
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (!data || data === '[DONE]') continue
      try { pending.push(JSON.parse(data) as Record<string, unknown>) } catch { /* skip */ }
    }
  }
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<Record<string, unknown>>> {
          while (true) {
            if (pending.length > 0) return { done: false, value: pending.shift()! }
            const { done, value } = await reader.read()
            if (done) {
              drainText(byteBuf.toString('utf-8'))
              byteBuf = Buffer.alloc(0)
              if (pending.length > 0) return { done: false, value: pending.shift()! }
              return { done: true, value: undefined as unknown as Record<string, unknown> }
            }
            byteBuf = Buffer.concat([byteBuf, Buffer.from(value)])
            let lastNL = -1
            for (let i = byteBuf.length - 1; i >= 0; i--) { if (byteBuf[i] === 0x0a) { lastNL = i; break } }
            if (lastNL < 0) continue
            const complete = byteBuf.slice(0, lastNL + 1).toString('utf-8')
            byteBuf = byteBuf.slice(lastNL + 1)
            drainText(complete)
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
  const apiKey = (client as unknown as Record<string, unknown>).apiKey as string
  const rawBaseUrl = ((client as unknown as Record<string, unknown>)._options as Record<string, unknown> | undefined)
    ?.baseURL as string || (client as unknown as Record<string, unknown>).baseURL as string || ''
  const fetchUrl = rawBaseUrl ? buildEndpointUrl(rawBaseUrl, 'chat/completions') : ''

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


// ---- Responses API 流式实现 ----

function mapResponsesArgIndex(
  itemIndexByOutput: Map<number, number>,
  outputIndex: number
): number {
  // function_call 在 Responses 里以 output_index 标识；映射为递增的本地 index，
  // 供 orchestrator 的 ToolCallAccumulator 累积参数。
  let idx = itemIndexByOutput.get(outputIndex)
  if (idx === undefined) {
    idx = itemIndexByOutput.size
    itemIndexByOutput.set(outputIndex, idx)
  }
  return idx
}

export async function* streamChatViaResponses(
  client: OpenAI,
  req: ChatRequest,
  signal?: AbortSignal,
  uaState?: { neutralUa: boolean; baseUrl?: string }
): AsyncGenerator<StreamChunk, void, unknown> {
  const apiKey = (client as unknown as Record<string, unknown>).apiKey as string
  const rawBaseUrl = ((client as unknown as Record<string, unknown>)._options as Record<string, unknown> | undefined)
    ?.baseURL as string || (client as unknown as Record<string, unknown>).baseURL as string || ''
  const fetchUrl = rawBaseUrl ? buildEndpointUrl(rawBaseUrl, 'responses') : ''

  const doRequest = async (forceNeutralUa: boolean): Promise<ReadableStreamDefaultReader<Uint8Array>> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    }
    if (forceNeutralUa) headers['User-Agent'] = NEUTRAL_UA
    const body: Record<string, unknown> = {
      model: req.model,
      input: toResponsesInput(req.messages),
      tools: toResponsesTools(req.tools),
      tool_choice: 'auto',
      stream: true
    }
    if (typeof req.maxOutputTokens === 'number') body['max_output_tokens'] = req.maxOutputTokens
    if (typeof req.temperature === 'number') body['temperature'] = req.temperature
    if (req.promptCacheKey) body['prompt_cache_key'] = req.promptCacheKey
    if (req.reasoningEffort) body['reasoning'] = { effort: req.reasoningEffort }

    const resp = await fetch(fetchUrl, { method: 'POST', headers, body: JSON.stringify(body), signal })
    if (!resp.ok) {
      const errStatus = resp.status
      const errText = await resp.text().catch(() => '')
      const err: Error & { status?: number } = new Error(`HTTP ${errStatus}: ${errText}`)
      err.status = errStatus
      throw err
    }
    const reader = resp.body?.getReader()
    if (!reader) throw new Error('No response body')
    return reader
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>
  try {
    reader = await doRequest(uaState?.neutralUa ?? false)
  } catch (e) {
    if (uaState && !uaState.neutralUa && isForbiddenError(e)) {
      uaState.neutralUa = true
      if (uaState.baseUrl) markEndpointNeutralUa(uaState.baseUrl)
      try { reader = await doRequest(true) } catch (e2) { throw sdkErrorToProviderError(e2) }
    } else {
      throw sdkErrorToProviderError(e)
    }
  }

  const itemIndexByOutput = new Map<number, number>()
  const callIdByOutput = new Map<number, string>()
  let imageCount = 0
  try {
    for await (const ev of makeJsonSSEIterable(reader)) {
      const type = ev.type as string | undefined
      if (!type) continue
      if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
        const delta = ev.delta
        if (typeof delta === 'string' && delta.length > 0) yield { type: 'text', text: delta }
      } else if (
        type === 'response.reasoning_summary_text.delta' ||
        type === 'response.reasoning_text.delta'
      ) {
        const delta = ev.delta
        if (typeof delta === 'string' && delta.length > 0) yield { type: 'thinking', text: delta }
      } else if (type === 'response.output_item.added') {
        const item = ev.item as Record<string, unknown> | undefined
        const outputIndex = typeof ev.output_index === 'number' ? ev.output_index : 0
        if (item?.type === 'function_call') {
          const callId = (item.call_id as string) || (item.id as string) || ''
          callIdByOutput.set(outputIndex, callId)
          const idx = mapResponsesArgIndex(itemIndexByOutput, outputIndex)
          yield { type: 'tool_call_delta', index: idx, id: callId, name: item.name as string, argumentsDelta: '' }
        }
      } else if (type === 'response.function_call_arguments.delta') {
        const outputIndex = typeof ev.output_index === 'number' ? ev.output_index : 0
        const idx = mapResponsesArgIndex(itemIndexByOutput, outputIndex)
        const delta = ev.delta
        if (typeof delta === 'string') {
          yield { type: 'tool_call_delta', index: idx, id: callIdByOutput.get(outputIndex), argumentsDelta: delta }
        }
      } else if (type === 'response.image_generation_call.partial_image') {
        const b64 = ev.partial_image_b64
        const idx = typeof ev.partial_image_index === 'number' ? ev.partial_image_index : 0
        if (typeof b64 === 'string' && b64.length > 0) {
          yield { type: 'image', base64: b64, mediaType: 'image/png', partial: true, index: idx }
        }
      } else if (type === 'response.completed' || type === 'response.incomplete') {
        const response = ev.response as Record<string, unknown> | undefined
        const output = Array.isArray(response?.output) ? (response!.output as Record<string, unknown>[]) : []
        for (const item of output) {
          if (item.type === 'image_generation_call' && typeof item.result === 'string' && item.result.length > 0) {
            yield { type: 'image', base64: item.result, mediaType: 'image/png', partial: false, index: imageCount++ }
          }
        }
        const usage = response?.usage as Record<string, unknown> | undefined
        if (usage) {
          const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined
          const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined
          const details = usage.input_tokens_details as Record<string, unknown> | undefined
          const cached = typeof details?.cached_tokens === 'number' ? details.cached_tokens : undefined
          yield {
            type: 'usage',
            inputTokens: cached !== undefined && inputTokens !== undefined ? Math.max(0, inputTokens - cached) : inputTokens,
            outputTokens,
            cacheReadInputTokens: cached
          }
        }
        const reason = type === 'response.incomplete' ? 'length' : 'stop'
        yield { type: 'done', finishReason: reason }
      } else if (type === 'response.failed' || type === 'error') {
        const response = ev.response as Record<string, unknown> | undefined
        const errObj = (response?.error as Record<string, unknown> | undefined) ?? ev
        const msg = typeof errObj?.message === 'string' ? errObj.message : 'Responses API 流式失败'
        throw new ProviderError('unknown', msg)
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
    if (req.imageGeneration) {
      return streamChatViaResponses(this.client, req, signal, this.uaState)
    }
    return streamChatViaOpenAI(this.client, req, signal, this.visionState, {
      dropReasoningContent: this.dropReasoningContent
    }, this.uaState)
  }
}
