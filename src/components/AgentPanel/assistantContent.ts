
const THINK_BLOCK_RE =
  /<(?:redacted_thinking|think(?:ing)?)>([\s\S]*?)<\/(?:redacted_thinking|think(?:ing)?)>/gi
const THINK_OPEN_RE = /<(?:redacted_thinking|think(?:ing)?)\s*>/gi
const THINK_ORPHAN_RE = /<\/?(?:redacted_thinking|think(?:ing)?)\s*>/gi

const PARTIAL_TAG_SUFFIX_RE = /<(?:\/?(?:redacted_thinking|think(?:ing)?)?)?[^>\s]*$/i

export function stripThinkMarkup(text: string, streaming?: boolean): string {
  // 孤立的 <think>/</think> 标签符号始终清除（只删标签、保留其中文字，安全）。
  // 结尾未闭合的半截标签仅在流式期间删除——完成后删它会误伤正文结尾内容。
  const withoutOrphan = text.replace(THINK_ORPHAN_RE, '')
  const cleaned = streaming ? withoutOrphan.replace(PARTIAL_TAG_SUFFIX_RE, '') : withoutOrphan
  return cleaned.trim()
}

export function extractThinkBlocks(
  raw: string,
  streaming?: boolean
): { body: string; extracted: string } {
  const chunks: string[] = []
  let body = raw

  // 完整配对的 <think>…</think> 始终抽离到思考区（无论是否流式）。
  body = body.replace(THINK_BLOCK_RE, (_, inner: string) => {
    const t = stripThinkMarkup(inner, streaming)
    if (t) chunks.push(t)
    return ''
  })

  // 未闭合的开标签：仅在流式期间把"尾巴"当作进行中的思考剥离并截断正文。
  // 完成后绝不截断——否则正文里合法出现的 <think>/含尖括号内容会导致后半段整段消失。
  if (streaming) {
    let lastOpen = -1
    for (const m of body.matchAll(THINK_OPEN_RE)) {
      if (m.index != null) lastOpen = m.index
    }
    if (lastOpen >= 0) {
      const tail = body.slice(lastOpen)
      const hasClose = /<\/(?:redacted_thinking|think(?:ing)?)\s*>/i.test(tail)
      if (!hasClose) {
        const inner = stripThinkMarkup(tail.replace(THINK_OPEN_RE, ''), streaming)
        if (inner) chunks.push(inner)
        body = body.slice(0, lastOpen)
      }
    }
  }

  body = stripThinkMarkup(body, streaming)
  body = body.replace(/\n{3,}/g, '\n\n').trim()

  return { body, extracted: chunks.join('\n\n').trim() }
}


export function isAssistantVisible(
  content: string,
  thinking?: string,
  streaming?: boolean
): boolean {
  if (streaming) return true
  const { body, thinking: t } = normalizeAssistantMessage(content, thinking, streaming)
  return t.length > 0 || body.length > 0
}


export function normalizeAssistantMessage(
  content: string,
  thinking?: string,
  streaming?: boolean
): { body: string; thinking: string } {
  const fromContent = extractThinkBlocks(content, streaming)
  const mergedThinking = [thinking?.trim(), fromContent.extracted]
    .filter((t): t is string => typeof t === 'string' && t.length > 0)
    .map((t) => stripThinkMarkup(t, streaming))
    .filter((t) => t.length > 0)
    .join('\n\n')
  return {
    body: fromContent.body,
    thinking: mergedThinking
  }
}
