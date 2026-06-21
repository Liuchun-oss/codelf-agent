
const THINK_BLOCK_RE =
  /<(?:redacted_thinking|think(?:ing)?)>([\s\S]*?)<\/(?:redacted_thinking|think(?:ing)?)>/gi
const THINK_OPEN_RE = /<(?:redacted_thinking|think(?:ing)?)\s*>/gi
const THINK_ORPHAN_RE = /<\/?(?:redacted_thinking|think(?:ing)?)\s*>/gi

const PARTIAL_TAG_SUFFIX_RE = /<(?:\/?(?:redacted_thinking|think(?:ing)?)?)?[^>\s]*$/i

export function stripThinkMarkup(text: string): string {
  return text.replace(THINK_ORPHAN_RE, '').replace(PARTIAL_TAG_SUFFIX_RE, '').trim()
}

export function extractThinkBlocks(raw: string): { body: string; extracted: string } {
  const chunks: string[] = []
  let body = raw

  body = body.replace(THINK_BLOCK_RE, (_, inner: string) => {
    const t = stripThinkMarkup(inner)
    if (t) chunks.push(t)
    return ''
  })

  let lastOpen = -1
  for (const m of body.matchAll(THINK_OPEN_RE)) {
    if (m.index != null) lastOpen = m.index
  }
  if (lastOpen >= 0) {
    const tail = body.slice(lastOpen)
    const hasClose = /<\/(?:redacted_thinking|think(?:ing)?)\s*>/i.test(tail)
    if (!hasClose) {
      const inner = stripThinkMarkup(tail.replace(THINK_OPEN_RE, ''))
      if (inner) chunks.push(inner)
      body = body.slice(0, lastOpen)
    }
  }

  body = stripThinkMarkup(body)
  body = body.replace(/\n{3,}/g, '\n\n').trim()

  return { body, extracted: chunks.join('\n\n').trim() }
}


export function isAssistantVisible(
  content: string,
  thinking?: string,
  streaming?: boolean
): boolean {
  if (streaming) return true
  const { body, thinking: t } = normalizeAssistantMessage(content, thinking)
  return t.length > 0 || body.length > 0
}


export function normalizeAssistantMessage(
  content: string,
  thinking?: string
): { body: string; thinking: string } {
  const fromContent = extractThinkBlocks(content)
  const mergedThinking = [thinking?.trim(), fromContent.extracted]
    .filter((t): t is string => typeof t === 'string' && t.length > 0)
    .map(stripThinkMarkup)
    .filter((t) => t.length > 0)
    .join('\n\n')
  return {
    body: fromContent.body,
    thinking: mergedThinking
  }
}
