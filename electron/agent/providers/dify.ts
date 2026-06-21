import type { ProviderProfile } from '@shared/agentTypes'
import { getFetchOptions } from './network'
import {
  BaseProviderAdapter,
  ProviderError,
  normalizeBaseUrl,
  type ChatMessage,
  type ChatRequest,
  type StreamChunk,
  type ToolDef
} from './base'

interface DifyRequest {
  inputs: Record<string, unknown>
  query: string
  response_mode: 'streaming' | 'blocking'
  conversation_id: string
  user: string
}

interface DifyStreamEvent {
  event: string
  conversation_id?: string
  message_id?: string
  answer?: string
  created_at?: number
  task_id?: string
  // agent_thought 事件专用
  id?: string
  position?: number
  thought?: string
  observation?: string
  tool?: string
  tool_labels?: Record<string, string>
  tool_input?: string
  message_files?: string[]
  // metadata
  metadata?: {
    usage?: {
      prompt_tokens?: number
      completion_tokens?: number
      total_tokens?: number
    }
  }
}

/**
 * 解析出的一个工具调用
 */
interface ParsedToolCall {
  name: string
  arguments: string
}

/**
 * Dify 原生适配器（支持客户端工具调用）
 *
 * 特点：
 * - 对话型应用（Chat App）专用，使用 /v1/chat-messages 端点
 * - 支持流式响应模式
 * - 自动管理 conversation_id 实现会话续接
 * - **支持客户端工具调用**：把 Codelf tools 注入 prompt，
 *   累积完整回复后用容错解析提取 <tool_use> 标记
 *
 * 解析策略：
 * Dify 的 SSE 逐 token 推送，工具标记会被任意拆分到多个 chunk。
 * 且 Codelf 上层是在流结束（done）后才执行工具（acc.finalize），
 * 流式逐字 yield 工具参数对执行无意义。因此当存在工具时，
 * 不再边流边解析，而是累积完整 answer，在 message_end 时统一解析，
 * 彻底规避 chunk 边界问题，并支持更宽松的格式容错。
 */
export class DifyAdapter extends BaseProviderAdapter {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly timeoutMs: number
  // 进程级缓存：记住每个 profile 对应的最新 conversation_id
  private static conversationCache = new Map<string, string>()

  constructor(profile: ProviderProfile, apiKey: string | null) {
    super()
    // Dify 控制台展示的 Base URL 通常带 /v1（如 http://host/v1）。
    // 这里统一去掉末尾的 /v1，再由 streamChat 拼接 /v1/chat-messages，
    // 这样用户填带 /v1 或不带 /v1 都能正常工作，避免 /v1/v1 双重前缀。
    this.baseUrl = normalizeBaseUrl(profile.baseUrl).replace(/\/v1$/i, '')
    this.apiKey = apiKey || ''
    this.timeoutMs = profile.timeoutMs || 120000
  }

  /**
   * 构建带工具定义的 query
   *
   * 包含完整的工具调用格式规范 + 动态工具清单。
   * 必须自包含，不能依赖 Dify 平台的系统提示词（用户可能未配置）。
   */
  private buildQueryWithTools(messages: ChatMessage[], tools?: ToolDef[]): string {
    const userMessages = messages.filter(m => m.role === 'user')
    const lastUser = userMessages[userMessages.length - 1]
    const baseQuery = lastUser?.content || ''

    if (!tools || tools.length === 0) {
      return baseQuery
    }

    // 构造工具说明（动态部分，随会话工具集变化）
    const toolsDesc = tools.map(t =>
      `- ${t.name}: ${t.description}\n  参数: ${JSON.stringify(t.parameters)}`
    ).join('\n')

    const instruction = `你有权限调用以下工具来完成用户任务。工具调用格式必须严格遵守 XML 标记：

<tool_use>
<name>工具名</name>
<args>{"参数名": "参数值"}</args>
</tool_use>

**硬性规则**：
1. 必须用 <tool_use> 标签包裹，不能用其他格式（JSON、代码块等）
2. <name> 里填工具名，<args> 里填合法 JSON 对象
3. 可以在工具调用前后输出文字说明，但工具标记本身必须完整
4. 一次可以调用多个工具，每个工具用独立的 <tool_use> 块
5. 工具执行后会返回结果，你需要根据结果继续回复用户

【本轮可用工具】
${toolsDesc}

【用户问题】
${baseQuery}`

    return instruction
  }

  /**
   * 从消息列表提取用户最后一条消息作为 query
   */
  private extractQuery(messages: ChatMessage[], tools?: ToolDef[]): string {
    return this.buildQueryWithTools(messages, tools)
  }

  /**
   * 获取或初始化会话 ID
   */
  private getConversationId(profileId: string): string {
    return DifyAdapter.conversationCache.get(profileId) || ''
  }

  /**
   * 更新会话 ID（每次响应后更新）
   */
  private updateConversationId(profileId: string, conversationId: string): void {
    if (conversationId) {
      DifyAdapter.conversationCache.set(profileId, conversationId)
    }
  }

  /**
   * 从完整回复文本中提取所有工具调用，容错解析。
   *
   * 支持的格式变体：
   * - 标准：<tool_use><name>x</name><args>{...}</args></tool_use>
   * - 标签大小写不敏感（<Tool_Use>、<NAME> 等）
   * - 别名标签：<tool_call> / <function_call> 等同于 <tool_use>
   * - args 用 <arguments>、<parameters>、<input> 等别名
   * - args 内容被 markdown 代码围栏包裹（```json ... ```）
   * - JSON 宽松：尾逗号、前后杂质会尝试修正
   * - args 的 JSON 字符串值内含 </args>、</tool_use> 等字面量（靠大括号配对扫描而非正则）
   *
   * 返回 { text, calls }：text 是剥离工具标记后的纯文本，calls 是工具调用列表。
   */
  private extractToolCalls(full: string): { text: string; calls: ParsedToolCall[] } {
    const calls: ParsedToolCall[] = []

    // 工具块：<tool_use> / <tool_call> / <function_call>，大小写不敏感，允许标签带属性
    const blockRe = /<(?:tool_use|tool_call|function_call)\b[^>]*>([\s\S]*?)<\/(?:tool_use|tool_call|function_call)>/gi
    const nameRe = /<name\b[^>]*>([\s\S]*?)<\/name>/i

    let text = full.replace(blockRe, (_match, inner: string) => {
      const nameM = nameRe.exec(inner)
      const name = nameM?.[1]?.trim() ?? ''
      // 名称缺失视为无效块，保留原文（不剥离），避免静默吞内容
      if (!name) return _match
      const rawArgs = this.extractArgs(inner)
      calls.push({ name, arguments: this.normalizeArgs(rawArgs) })
      return ''
    })

    // 兜底：识别裸 JSON 函数调用格式。
    // 千问等模型经 Dify chat-messages 透传时，原生 function call 会被降级为
    // 文本里的裸 JSON（如 {"name":"write_file","arguments":{...}}）。
    // 仅在 XML 块未命中时扫描，避免与已解析的工具块重复。
    if (calls.length === 0) {
      const jsonCalls = this.extractJsonToolCalls(text)
      if (jsonCalls.calls.length > 0) {
        calls.push(...jsonCalls.calls)
        text = jsonCalls.text
      }
    }

    return { text: text.trim(), calls }
  }

  /**
   * 从文本中提取裸 JSON 格式的函数调用，容错解析。
   *
   * 支持的形态：
   * - {"name": "x", "arguments": {...}}
   * - {"name": "x", "parameters": {...}}
   * - {"name": "x", "arguments": "{...}"}（arguments 为 JSON 字符串）
   * - 被 ```json ... ``` 代码围栏包裹
   * - 文本中夹杂多个调用对象
   *
   * 返回 { text, calls }：text 是剥离 JSON 调用后的纯文本，calls 是调用列表。
   */
  private extractJsonToolCalls(full: string): { text: string; calls: ParsedToolCall[] } {
    const calls: ParsedToolCall[] = []
    const ranges: Array<[number, number]> = []

    // 从每个 '{' 起尝试配对扫描出完整 JSON 对象，命中含 name 的函数调用结构则采纳
    let searchFrom = 0
    while (searchFrom < full.length) {
      const start = full.indexOf('{', searchFrom)
      if (start === -1) break
      const json = this.scanJsonObject(full, start)
      if (json === null) break

      const parsed = this.tryParseJsonCall(json)
      if (parsed) {
        calls.push(parsed)
        ranges.push([start, start + json.length])
        searchFrom = start + json.length
      } else {
        searchFrom = start + 1
      }
    }

    if (calls.length === 0) return { text: full, calls }

    // 剥离已识别为工具调用的 JSON 片段，保留其余文本
    let text = ''
    let cursor = 0
    for (const [s, e] of ranges) {
      text += full.slice(cursor, s)
      cursor = e
    }
    text += full.slice(cursor)

    // 顺带清掉可能残留的空代码围栏
    text = text.replace(/```[a-zA-Z]*\s*```/g, '')

    return { text, calls }
  }

  /**
   * 尝试把一个 JSON 对象字符串解析为函数调用。
   * 必须含字符串 name 字段，args 取 arguments/parameters/args/input/parameter 之一。
   * 不符合则返回 null（不是工具调用，比如普通数据对象）。
   */
  private tryParseJsonCall(json: string): ParsedToolCall | null {
    let obj: unknown
    try {
      obj = JSON.parse(json)
    } catch {
      return null
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
    const rec = obj as Record<string, unknown>

    // 兼容 OpenAI function 包裹形态：{"type":"function","function":{"name":...,"arguments":...}}
    const fn = rec.function && typeof rec.function === 'object' && !Array.isArray(rec.function)
      ? (rec.function as Record<string, unknown>)
      : rec

    const name = typeof fn.name === 'string' ? fn.name.trim() : ''
    if (!name) return null

    const rawArgs = fn.arguments ?? fn.parameters ?? fn.args ?? fn.input ?? fn.parameter
    let argsStr: string
    if (rawArgs === undefined || rawArgs === null) {
      argsStr = '{}'
    } else if (typeof rawArgs === 'string') {
      argsStr = rawArgs
    } else {
      argsStr = JSON.stringify(rawArgs)
    }

    return { name, arguments: this.normalizeArgs(argsStr) }
  }

  /**
   * 流式检测用：找到文本中第一个「函数调用 JSON 对象」的起始 '{' 位置。
   *
   * 逐个 '{' 尝试配对扫描出完整 JSON 并校验是否为函数调用结构；命中即返回其起始索引。
   * 若某个 '{' 还没收齐完整 JSON（scanJsonObject 返回 null，说明流还没推完），
   * 仅当其开头已能看出像函数调用（带 "name" 键）时才返回该位置转入缓冲，
   * 避免普通文本里的 '{'（代码片段、JSON 示例等）误触发缓冲、中断流式输出。
   * 没有任何候选返回 -1。
   */
  private firstJsonCallIndex(s: string): number {
    // 形如 {"name" / { "name" / {'name'，允许 { 后有空白
    const looksLikeCallHead = /^\{\s*["']?name["']?\s*:/i
    let from = 0
    while (from < s.length) {
      const start = s.indexOf('{', from)
      if (start === -1) return -1
      const json = this.scanJsonObject(s, start)
      if (json === null) {
        // 尚未收齐完整 JSON：仅当已能看出是函数调用开头时才转入缓冲。
        const head = s.slice(start)
        if (looksLikeCallHead.test(head) || this.isPrefixOfCallHead(head)) return start
        // 否则这个 '{' 后面再没有完整对象了，且不像调用——无需缓冲。
        return -1
      }
      if (this.tryParseJsonCall(json)) return start
      // 是个完整但非调用的 JSON 对象（普通数据），跳过继续找。
      from = start + json.length
    }
    return -1
  }

  /**
   * 判断 head 是否是 `{"name":` 这类函数调用开头的一个前缀
   * （流式逐字推送时，"name" 键可能只到了一半，如 `{"na`）。
   */
  private isPrefixOfCallHead(head: string): boolean {
    const target = '{"name":'
    // head 去掉 { 后的空白再比对，宽松匹配引号有无
    const normalized = head.replace(/^\{\s*/, '{').toLowerCase()
    const targetLc = target.toLowerCase()
    const minLen = Math.min(normalized.length, targetLc.length)
    return normalized.slice(0, minLen) === targetLc.slice(0, minLen)
  }

  /**
   * 从一个工具块内部提取 args 原始内容。
   *
   * 优先用大括号配对扫描（带字符串/转义感知）截取首个完整 JSON 对象，
   * 这样即使 JSON 字符串值里含 </args> / </tool_use> 字面量也不会被截断。
   * 找不到 JSON 对象时，回退到 <args> 别名标签的正则匹配。
   */
  private extractArgs(inner: string): string {
    // args 别名标签的开始位置（若有），从其后开始扫描，避免把 <name> 里的内容当参数
    const openRe = /<(?:args|arguments|parameters|params|input)\b[^>]*>/i
    const openM = openRe.exec(inner)
    const scanFrom = openM ? openM.index + openM[0].length : 0

    const json = this.scanJsonObject(inner, scanFrom)
    if (json !== null) return json

    // 回退：非贪婪正则（无 JSON 对象时，例如参数为空或非对象）
    const argsRe = /<(?:args|arguments|parameters|params|input)\b[^>]*>([\s\S]*?)<\/(?:args|arguments|parameters|params|input)>/i
    const argsM = argsRe.exec(inner)
    return argsM?.[1]?.trim() ?? ''
  }

  /**
   * 从 text 的 startPos 起，找到首个 '{' 并做大括号配对扫描，
   * 返回完整 JSON 对象子串；失败返回 null。
   * 扫描时正确跳过字符串字面量与转义，使得字符串内的 {} 不影响配对。
   */
  private scanJsonObject(text: string, startPos: number): string | null {
    const start = text.indexOf('{', startPos)
    if (start === -1) return null

    let depth = 0
    let inStr = false
    let escaped = false
    for (let i = start; i < text.length; i++) {
      const ch = text[i]
      if (inStr) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inStr = false
        continue
      }
      if (ch === '"') inStr = true
      else if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) return text.slice(start, i + 1)
      }
    }
    return null
  }

  /**
   * 规范化工具参数为合法 JSON 字符串。
   * 尽力修正常见的非标准写法；无法修正时原样返回（交由上层 parseToolArguments 兜底）。
   */
  private normalizeArgs(raw: string): string {
    if (!raw) return '{}'
    let s = raw.trim()

    // 去掉 markdown 代码围栏：```json ... ``` 或 ``` ... ```
    const fence = /^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/.exec(s)
    if (fence) s = fence[1].trim()

    // 已是合法 JSON，直接返回
    try {
      JSON.parse(s)
      return s
    } catch {
      // 继续尝试修正
    }

    // 尝试只截取第一个 { 到最后一个 } 之间的内容（去掉前后杂质）
    const first = s.indexOf('{')
    const last = s.lastIndexOf('}')
    if (first !== -1 && last > first) {
      const sliced = s.slice(first, last + 1)
      try {
        JSON.parse(sliced)
        return sliced
      } catch {
        s = sliced
      }
    }

    // 修正尾逗号：{"a":1,} -> {"a":1}
    const noTrailingComma = s.replace(/,\s*([}\]])/g, '$1')
    try {
      JSON.parse(noTrailingComma)
      return noTrailingComma
    } catch {
      // 最后兜底：原样返回，上层 parseToolArguments 解析失败会反馈给模型重试
      return s
    }
  }

  async *streamChat(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamChunk, void, unknown> {
    const query = this.extractQuery(req.messages, req.tools)
    if (!query) {
      throw new ProviderError('unknown', '未找到用户消息')
    }

    const profileId = this.baseUrl
    const conversationId = this.getConversationId(profileId)

    const difyReq: DifyRequest = {
      inputs: {},
      query: query,
      response_mode: 'streaming',
      conversation_id: conversationId,
      user: 'codelf-user'
    }

    const url = `${this.baseUrl}/v1/chat-messages`
    const networkOpts = getFetchOptions()

    // 合并 signal：如果上层传了 signal，优先使用；否则用 timeout 创建一个
    let finalSignal = signal
    let timeoutController: AbortController | undefined
    if (!signal && this.timeoutMs > 0) {
      timeoutController = new AbortController()
      finalSignal = timeoutController.signal
      setTimeout(() => timeoutController!.abort(), this.timeoutMs)
    }

    const fetchOpts = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(difyReq),
      signal: finalSignal,
      ...networkOpts
    }

    let response: Response
    try {
      response = await fetch(url, fetchOpts)
    } catch (e: unknown) {
      // 超时错误特殊处理
      if (timeoutController && (e as { name?: string })?.name === 'AbortError') {
        throw new ProviderError('provider_timeout', `请求超时（${this.timeoutMs}ms）`, undefined, e)
      }
      throw new ProviderError('network', '无法连接到 Dify 服务', undefined, e)
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      if (response.status === 401 || response.status === 403) {
        throw new ProviderError('provider_auth', 'Dify API Key 无效', response.status)
      }
      if (response.status === 404) {
        throw new ProviderError('provider_not_found', 'Dify 端点不存在，请检查 Base URL', response.status)
      }
      if (response.status === 429) {
        throw new ProviderError('provider_rate_limit', 'Dify 配额不足或限流', response.status)
      }
      if (response.status >= 500) {
        throw new ProviderError('provider_server', `Dify 服务端错误（${response.status}）`, response.status)
      }
      throw new ProviderError('unknown', `请求失败（${response.status}）：${text}`, response.status)
    }

    const reader = response.body?.getReader()
    if (!reader) {
      throw new ProviderError('unknown', 'Dify 响应无 body')
    }

    const decoder = new TextDecoder()
    let buffer = ''
    let lastConversationId = conversationId

    const hasTools = !!(req.tools && req.tools.length > 0)

    // 工具解析状态（仅在 hasTools 时使用）
    // acc：累积的完整 answer；emittedLen：已作为 text 流式输出的字符数；
    // toolDetected：是否已检测到工具标记（一旦检测到就停止流式、转为缓冲）。
    let acc = ''
    let emittedLen = 0
    let toolDetected = false

    // 计算需要保留不输出的结尾长度：acc 的结尾若可能是工具标记的前缀，则保留等待后续字符。
    const OPEN_TAGS = ['<tool_use', '<tool_call', '<function_call']
    const maxOpenLen = Math.max(...OPEN_TAGS.map((t) => t.length))
    const heldBackLen = (s: string): number => {
      const maxCheck = Math.min(maxOpenLen, s.length)
      for (let n = maxCheck; n > 0; n--) {
        const suffix = s.slice(s.length - n).toLowerCase()
        if (OPEN_TAGS.some((t) => t.startsWith(suffix))) return n
      }
      return 0
    }
    // 找到第一个工具标记的位置：XML 开标签，或裸 JSON 函数调用的起始 '{'。
    // 裸 JSON 兜底：千问等模型经 Dify chat-messages 透传时，原生 function call
    // 被降级为文本里的 {"name":...,"arguments":...}。检测到这类结构的起始 '{'
    // 即转入缓冲，避免逐字把 JSON 当普通文本输出。返回 -1 表示未检测到。
    const firstOpenTagIndex = (s: string): number => {
      const xmlM = /<(?:tool_use|tool_call|function_call)\b/i.exec(s)
      const xmlIdx = xmlM ? xmlM.index : -1
      const jsonIdx = this.firstJsonCallIndex(s)
      if (xmlIdx === -1) return jsonIdx
      if (jsonIdx === -1) return xmlIdx
      return Math.min(xmlIdx, jsonIdx)
    }

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.trim() || !line.startsWith('data: ')) continue

          const jsonStr = line.replace(/^data:\s*/, '')
          let event: DifyStreamEvent
          try {
            event = JSON.parse(jsonStr)
          } catch {
            continue
          }

          // 更新会话 ID
          if (event.conversation_id) {
            lastConversationId = event.conversation_id
          }

          // agent_message 和 message 事件 -> 累积并按需流式输出文本
          if (event.event === 'agent_message' || event.event === 'message') {
            if (event.answer) {
              if (!hasTools) {
                // 无工具：直接流式输出
                yield { type: 'text', text: event.answer }
              } else {
                acc += event.answer
                if (!toolDetected) {
                  const openIdx = firstOpenTagIndex(acc)
                  if (openIdx === -1) {
                    // 尚无工具标记：流式输出安全部分，保留可能是标记前缀的结尾
                    const safeUpto = acc.length - heldBackLen(acc)
                    if (safeUpto > emittedLen) {
                      yield { type: 'text', text: acc.slice(emittedLen, safeUpto) }
                      emittedLen = safeUpto
                    }
                  } else {
                    // 检测到工具标记：先吐出标记前未输出的文本，然后转入缓冲模式
                    if (openIdx > emittedLen) {
                      yield { type: 'text', text: acc.slice(emittedLen, openIdx) }
                      emittedLen = openIdx
                    }
                    toolDetected = true
                  }
                }
                // toolDetected 后只累积、不输出，等 message_end 统一解析
              }
            }
          }

          // message_end 事件 -> 结束
          if (event.event === 'message_end') {
            // 收尾：处理工具解析与剩余文本
            if (hasTools) {
              if (toolDetected) {
                // emittedLen 之前已作为纯文本输出（且一定在首个工具标记之前，不含标记）。
                // 只对尚未输出的部分做工具提取，避免与已输出内容重叠错位。
                const rest = acc.slice(emittedLen)
                const { text, calls } = this.extractToolCalls(rest)
                if (text) {
                  yield { type: 'text', text }
                }
                // 逐个发出工具调用：一次性给出完整 name 与 arguments
                for (let i = 0; i < calls.length; i++) {
                  yield {
                    type: 'tool_call_delta',
                    index: i,
                    id: `call_${i}`,
                    name: calls[i].name,
                    argumentsDelta: calls[i].arguments
                  }
                }
              } else {
                // 全程无工具标记：吐出剩余保留的文本
                if (acc.length > emittedLen) {
                  yield { type: 'text', text: acc.slice(emittedLen) }
                }
              }
            }

            if (event.metadata?.usage) {
              const u = event.metadata.usage
              yield {
                type: 'usage',
                inputTokens: u.prompt_tokens,
                outputTokens: u.completion_tokens
              }
            }
            yield { type: 'done', finishReason: toolDetected ? 'tool_calls' : 'stop' }

            // 更新会话缓存
            this.updateConversationId(profileId, lastConversationId)
            return
          }

          // error 事件 -> 抛出错误
          if (event.event === 'error') {
            const msg = (event as unknown as { message?: string }).message || 'Dify 返回错误'
            throw new ProviderError('unknown', msg)
          }
        }
      }

      // 流结束但没收到 message_end：补发剩余文本与工具调用
      if (hasTools && toolDetected) {
        const rest = acc.slice(emittedLen)
        const { text, calls } = this.extractToolCalls(rest)
        if (text) yield { type: 'text', text }
        for (let i = 0; i < calls.length; i++) {
          yield {
            type: 'tool_call_delta',
            index: i,
            id: `call_${i}`,
            name: calls[i].name,
            argumentsDelta: calls[i].arguments
          }
        }
      } else if (hasTools && acc.length > emittedLen) {
        yield { type: 'text', text: acc.slice(emittedLen) }
      }
      this.updateConversationId(profileId, lastConversationId)
      yield { type: 'done', finishReason: toolDetected ? 'tool_calls' : 'stop' }

    } finally {
      reader.releaseLock()
    }
  }
}
