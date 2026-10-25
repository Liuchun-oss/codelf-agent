// MiniMax-M3 的工具调用不是 OpenAI 的 tool_calls，而是带命名空间前缀的 XML 方言：
//
//   ]<]minimax[>[<tool_call>
//   ]<]minimax[>[<invoke name="read_file">
//   ]<]minimax[>[<path>.codelf/plan/x.md]<]minimax[>[</path>
//   ]<]minimax[>[</invoke>
//   ]<]minimax[>[</tool_call>
//
// 与 vLLM 的 vllm/parser/minimax_m3.py 一致（NAMESPACE = "]<]minimax[>["）。
// 上游网关若把这个前缀只剥掉一半，就会在参数值里残留 `]`/`[` 碎片（issue #7 里
// read_file 的 path 尾部多出 `]`，于是路径失效），或者把整段 XML 原样回灌进
// content / function.arguments，被历史反复重发后越滚越大。
//
// 本模块只做两件事：
// ① 剥掉前缀及其残缺形态；
// ② 该方言只出现在正文里时，把它还原成工具调用（否则工具根本不会被执行）。

export const MINIMAX_NS = ']<]minimax[>['

// 完整前缀去掉首尾括号后的形态：上游「剥了一半」时最常见。
const MINIMAX_NS_PARTIAL = '<]minimax[>'

// 覆盖全部残缺形态：`]<]minimax[>[`、`<]minimax[>`、`]minimax>[`、`[]minimax[>` …
// 两条分支都强制出现尖括号或括号，避免误伤正文里单独出现的单词 minimax。
const ARTIFACT_RE = /[[\]]*<\]?minimax\[?>[[\]]*|[[\]]+minimax\[?>[[\]]*/g
const ARTIFACT_TEST_RE = new RegExp(ARTIFACT_RE.source)

export function hasMinimaxArtifacts(text: string): boolean {
  if (!text || !text.includes('minimax')) return false
  return ARTIFACT_TEST_RE.test(text)
}

export function stripMinimaxArtifacts(text: string): string {
  if (!text || !text.includes('minimax')) return text
  return text.replace(ARTIFACT_RE, '')
}

const NAMED_ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'"
}

function decodeEntities(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    const key = body.toLowerCase()
    const named = NAMED_ENTITIES[key]
    if (named) return named
    const code = key.startsWith('#x')
      ? parseInt(key.slice(2), 16)
      : key.startsWith('#')
        ? parseInt(key.slice(1), 10)
        : NaN
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match
    try {
      return String.fromCodePoint(code)
    } catch {
      return match
    }
  })
}

interface ParsedElement {
  name: string
  attrs: Record<string, string>
  value: unknown
  end: number
}

const OPEN_TAG_RE =
  /^([A-Za-z_$][\w$.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))*)\s*(\/)?$/
const ATTR_RE = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g

function parseAttrs(src: string): Record<string, string> {
  const out: Record<string, string> = {}
  ATTR_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ATTR_RE.exec(src))) {
    out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? ''
  }
  return out
}

function cleanValueText(raw: string): string {
  const hadArtifact = hasMinimaxArtifacts(raw)
  let s = stripMinimaxArtifacts(raw)
  // 前缀被剥成两半时，它的括号会分别落在「值尾部」和「下一个标签前」。
  // 只有在值本身确实带过前缀碎片时才裁括号，避免误伤 `foo[1].ts` 这种正常值。
  if (hadArtifact) s = s.replace(/^[[\]]+/, '').replace(/[[\]]+$/, '')
  return decodeEntities(s).trim()
}

function buildValue(text: string, children: ParsedElement[]): unknown {
  if (children.length === 0) return cleanValueText(text)
  const keys = children.map(elementKey)
  // 列表在方言里渲染成同名子元素（规范写法是 <item>），据此还原成数组。
  if (keys.every((k) => k === keys[0])) return children.map((c) => c.value)
  const obj: Record<string, unknown> = {}
  const plainText = cleanValueText(text)
  if (plainText) obj['$text'] = plainText
  for (const child of children) {
    const key = elementKey(child)
    const existing = obj[key]
    if (existing === undefined) obj[key] = child.value
    else if (Array.isArray(existing)) existing.push(child.value)
    else obj[key] = [existing, child.value]
  }
  return obj
}

// `<parameter name="path">x</parameter>`（Claude 式参数写法）与
// `<path>x</path>`（MiniMax-M3 写法）都归一到同一个键。
function elementKey(el: ParsedElement): string {
  if (el.name === 'parameter' || el.name === 'arg') return el.attrs['name'] || el.name
  return el.name
}

// 解析 src[pos] 处的单个元素；结构不合法（未闭合、走到别的闭合标签）时返回 null。
function parseElement(src: string, pos: number): ParsedElement | null {
  const lt = src.indexOf('<', pos)
  if (lt < 0) return null
  const gt = src.indexOf('>', lt)
  if (gt < 0) return null
  const tag = src.slice(lt + 1, gt)
  if (tag.startsWith('/') || tag.startsWith('!') || tag.startsWith('?')) return null
  const tagMatch = OPEN_TAG_RE.exec(tag)
  if (!tagMatch) return null
  const name = tagMatch[1]
  const attrs = parseAttrs(tagMatch[2] ?? '')
  if (tagMatch[3] === '/') return { name, attrs, value: '', end: gt + 1 }

  const closeTag = `</${name}>`
  let i = gt + 1
  const textParts: string[] = []
  const children: ParsedElement[] = []
  while (true) {
    const next = src.indexOf('<', i)
    if (next < 0) return null
    if (src.startsWith(closeTag, next)) {
      textParts.push(src.slice(i, next))
      return {
        name,
        attrs,
        value: buildValue(textParts.join(''), children),
        end: next + closeTag.length
      }
    }
    if (src.startsWith('</', next)) return null
    const child = parseElement(src, next)
    if (!child) return null
    textParts.push(src.slice(i, next))
    children.push(child)
    i = child.end
  }
}

function parseElementList(src: string, pos: number): { args: Record<string, unknown>; end: number } {
  const args: Record<string, unknown> = {}
  let i = pos
  while (i < src.length) {
    const el = parseElement(src, i)
    if (!el) break
    const key = elementKey(el)
    const existing = args[key]
    if (existing === undefined) args[key] = el.value
    else if (Array.isArray(existing)) existing.push(el.value)
    else args[key] = [existing, el.value]
    i = el.end
  }
  return { args, end: i }
}

export interface InbandToolCall {
  name: string
  arguments: string
}

const INVOKE_RE = /<invoke\b[^>]*>/gi
const INVOKE_NAME_RE = /name\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i

/**
 * 把一段 MiniMax-M3 方言文本切成「正文 + 工具调用」。
 * 正文里的工具块会被移除（模型把协议当正文吐出来时不该继续展示），
 * 解析失败的部分保持原样返回，宁可显式可见也不静默丢弃内容。
 */
export function parseMinimaxToolCalls(raw: string): { text: string; calls: InbandToolCall[] } {
  if (!raw) return { text: '', calls: [] }
  const src = stripMinimaxArtifacts(raw)
  const calls: InbandToolCall[] = []
  const spans: Array<{ start: number; end: number }> = []

  INVOKE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = INVOKE_RE.exec(src))) {
    const nameMatch = INVOKE_NAME_RE.exec(m[0])
    const name = (nameMatch?.[1] ?? nameMatch?.[2] ?? nameMatch?.[3] ?? '').trim()
    const bodyStart = m.index + m[0].length
    const closeIdx = src.indexOf('</invoke>', bodyStart)
    // 缺少 </invoke> 时只吃到下一个 <invoke> 为止，避免吞掉后续调用。
    const nextInvoke = src.indexOf('<invoke', bodyStart)
    const end =
      closeIdx >= 0
        ? closeIdx + '</invoke>'.length
        : nextInvoke >= 0
          ? nextInvoke
          : src.length
    const { args } = parseElementList(src, bodyStart)
    if (name) {
      calls.push({ name, arguments: JSON.stringify(args) })
      spans.push({ start: m.index, end })
    }
  }

  if (calls.length === 0) return { text: raw, calls: [] }

  let text = ''
  let cursor = 0
  for (const span of spans) {
    text += src.slice(cursor, span.start)
    cursor = span.end
  }
  text += src.slice(cursor)
  text = text.replace(/<\/?tool_calls?>/gi, '')
  return { text, calls }
}

/**
 * 兜底解析：当 function.arguments 不是 JSON，而是方言原文（整段 <invoke> 或裸的参数元素）时使用。
 * 解析不出来返回 null，交回上层报「参数解析失败」。
 */
export function parseMinimaxArguments(raw: string): Record<string, unknown> | null {
  if (!raw || !raw.includes('<')) return null
  const { calls } = parseMinimaxToolCalls(raw)
  if (calls.length > 0) {
    try {
      return JSON.parse(calls[0].arguments) as Record<string, unknown>
    } catch {
      return null
    }
  }
  const { args } = parseElementList(stripMinimaxArtifacts(raw), 0)
  return Object.keys(args).length > 0 ? args : null
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    if (!hasMinimaxArtifacts(value)) return value
    return stripMinimaxArtifacts(value).replace(/^[[\]]+/, '').replace(/[[\]]+$/, '')
  }
  if (Array.isArray(value)) return value.map(sanitizeValue)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = sanitizeValue(v)
    return out
  }
  return value
}

/** 清洗已经解析成对象的工具参数：去掉字符串值里残留的命名空间碎片。 */
export function sanitizeToolArgs<T>(value: T): T {
  return sanitizeValue(value) as T
}

// 方言里的值一律是字符串，而工具参数 schema（zod）对 number/boolean 是严格类型，
// 所以合成工具调用时要按工具声明的 JSON Schema 还原类型。
export function coerceToolArgs(args: Record<string, unknown>, schema: unknown): Record<string, unknown> {
  const coerced = coerceBySchema(args, schema)
  return coerced && typeof coerced === 'object' && !Array.isArray(coerced)
    ? (coerced as Record<string, unknown>)
    : args
}

function coerceBySchema(value: unknown, schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return value
  const s = schema as Record<string, unknown>
  for (const alt of ['anyOf', 'oneOf']) {
    const choices = s[alt]
    if (Array.isArray(choices)) {
      for (const choice of choices) {
        const next = coerceBySchema(value, choice)
        if (next !== value) return next
      }
      return value
    }
  }
  const types = s['type']
  const kind = Array.isArray(types) ? types.find((t) => typeof value !== 'string' || t !== 'string') : types

  if (kind === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    const props = (s['properties'] as Record<string, unknown> | undefined) ?? {}
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = k in props ? coerceBySchema(v, props[k]) : v
    }
    return out
  }
  if (kind === 'array') {
    const items = s['items']
    if (Array.isArray(value)) return items ? value.map((v) => coerceBySchema(v, items)) : value
    if (typeof value === 'string' && value.trim()) return [coerceBySchema(value, items)]
    return value
  }
  if (kind === 'number' || kind === 'integer') {
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      const n = Number(value)
      return kind === 'integer' ? Math.trunc(n) : n
    }
    return value
  }
  if (kind === 'boolean' && typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === 'true') return true
    if (v === 'false') return false
    return value
  }
  if (kind === 'string' && typeof value !== 'string') {
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    return value
  }
  return value
}

export interface MinimaxStreamFilter {
  push(text: string): string
  finish(): { text: string; calls: InbandToolCall[]; sawProtocol: boolean }
}

// 残缺前缀是完整前缀的子串（少一个前导 `]`），所以紧跟在 `]` 之后的残缺形态
// 其实属于完整前缀：必须跳过，否则它前一位的 `]` 会被当成正文漏出去。
function firstMarkerIndex(text: string): number {
  let best = text.indexOf(MINIMAX_NS)
  let from = 0
  while (true) {
    const idx = text.indexOf(MINIMAX_NS_PARTIAL, from)
    if (idx < 0) break
    if (idx === 0 || text[idx - 1] !== ']') {
      if (best < 0 || idx < best) best = idx
      break
    }
    from = idx + 1
  }
  return best
}

// 结尾处可能是「被 chunk 切断的半个前缀」，需要扣住不给上层。
function longestMarkerPrefixSuffix(text: string): number {
  let keep = 0
  for (const marker of [MINIMAX_NS, MINIMAX_NS_PARTIAL]) {
    for (let len = Math.min(marker.length - 1, text.length); len > 0; len--) {
      if (text.endsWith(marker.slice(0, len))) {
        if (len > keep) keep = len
        break
      }
    }
  }
  return keep
}

/**
 * 流式过滤器：正文照常流式输出，但一旦出现命名空间前缀，后续内容全都按协议缓冲，
 * 结束时统一解析成工具调用。前缀跨 chunk 被切断时也不会漏字符。
 */
export function createMinimaxStreamFilter(): MinimaxStreamFilter {
  let pending = ''
  let protocol = ''
  let inProtocol = false
  let fenceOpen = false
  let fenceScan = ''

  // 代码围栏可能被 chunk 切开，保留尾部两个字符继续拼。
  const toggleFence = (text: string): void => {
    fenceScan += text
    let count = 0
    let i = fenceScan.indexOf('```')
    while (i >= 0) {
      count++
      i = fenceScan.indexOf('```', i + 3)
    }
    if (count % 2 === 1) fenceOpen = !fenceOpen
    fenceScan = fenceScan.slice(-2)
  }

  return {
    push(text: string): string {
      if (!text) return ''
      if (inProtocol) {
        protocol += text
        return ''
      }
      pending += text
      toggleFence(text)
      // 代码块里的同名 XML 是「示例/文档」，不是模型发起的工具调用，原样输出。
      if (fenceOpen) {
        const out = pending
        pending = ''
        return out
      }
      const idx = firstMarkerIndex(pending)
      if (idx >= 0) {
        const head = pending.slice(0, idx)
        protocol = pending.slice(idx)
        pending = ''
        inProtocol = true
        return head
      }
      const keep = longestMarkerPrefixSuffix(pending)
      const out = keep > 0 ? pending.slice(0, pending.length - keep) : pending
      pending = keep > 0 ? pending.slice(pending.length - keep) : ''
      return out
    },

    finish(): { text: string; calls: InbandToolCall[]; sawProtocol: boolean } {
      if (!inProtocol) {
        const rest = stripMinimaxArtifacts(pending)
        pending = ''
        return { text: rest, calls: [], sawProtocol: false }
      }
      const raw = protocol
      protocol = ''
      return { ...parseMinimaxToolCalls(raw), sawProtocol: true }
    }
  }
}
