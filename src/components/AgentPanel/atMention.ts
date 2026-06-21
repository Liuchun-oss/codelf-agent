

export interface AtMentionRange {
  
  atIndex: number
  
  cursor: number
  
  query: string
}

const MAX_QUERY_LEN = 200


export function detectAtMention(text: string, cursor: number): AtMentionRange | null {
  if (cursor < 0 || cursor > text.length) return null

  const before = text.slice(0, cursor)
  const atIndex = before.lastIndexOf('@')
  if (atIndex < 0) return null

  
  if (atIndex > 0) {
    const prev = before[atIndex - 1]
    if (prev !== ' ' && prev !== '\n' && prev !== '\r' && prev !== '\t') return null
  }

  const query = before.slice(atIndex + 1)
  if (query.length > MAX_QUERY_LEN) return null
  if (/[\s\n\r\t]/.test(query)) return null

  return { atIndex, cursor, query }
}


export function removeAtMention(text: string, range: AtMentionRange): { text: string; cursor: number } {
  const next = text.slice(0, range.atIndex) + text.slice(range.cursor)
  return { text: next, cursor: range.atIndex }
}
