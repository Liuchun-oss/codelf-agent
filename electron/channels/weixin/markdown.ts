// markdown → 纯文本：微信不渲染 markdown，回信前把模型输出降级为可读纯文本。
// 见策划书 4.5 / B 区。保守处理：保留代码块内容（去掉围栏），剥离常见标记。

export function markdownToPlainText(md: string): string {
  if (!md) return ''
  let text = md

  // 图片/截图会被通道层单独作为图片消息发送，正文里不应再出现内部 URL。
  // 图片 ![alt](codelf-artifact://...) 或 ![alt](codelf-preview://...) → 整体移除。
  text = text.replace(/!\[[^\]]*\]\((?:codelf-artifact|codelf-preview):\/\/[^)\s]+\)/g, '')

  // 代码块：去掉 ``` 围栏与语言标注，保留内部代码原样。
  text = text.replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, code: string) => code.replace(/\n+$/, ''))
  // 行内代码：去掉反引号。
  text = text.replace(/`([^`]+)`/g, '$1')

  // 图片 ![alt](url) → alt（或 url）。
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt: string, url: string) => alt || url)
  // 链接 [text](url) → text (url)。
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) =>
    label && label !== url ? `${label} (${url})` : url
  )

  // 标题 #、引用 >。
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '')
  text = text.replace(/^\s{0,3}>\s?/gm, '')

  // 加粗：**x** / __x__。
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1')
  text = text.replace(/__([^_]+)__/g, '$1')
  // 斜体：*x*（星号）。下划线斜体只在词边界处理，避免破坏 snake_case 标识符
  // （如 get_updates_buf）和文件路径。
  text = text.replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![*\w])/g, '$1$2')
  text = text.replace(/(^|[^_\w])_(?!\s)([^_\n]+?)(?<!\s)_(?![_\w])/g, '$1$2')
  text = text.replace(/~~(.*?)~~/g, '$1')

  // 无序列表标记统一成「- 」，有序列表保留数字。
  text = text.replace(/^\s{0,3}[*+]\s+/gm, '- ')

  // 水平分割线。
  text = text.replace(/^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/gm, '────────')

  // 压缩 3+ 连续空行为 2 行。
  text = text.replace(/\n{3,}/g, '\n\n')

  return text.trim()
}

// B4：按 4000 字上限分块，优先在段落（\n\n）> 换行（\n）> 句末边界切。
// 尽量整块发送代码块，过长再硬切。
export function chunkText(text: string, limit = 4000): string[] {
  if (!text) return []
  if (text.length <= limit) return [text]

  const chunks: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = findCutPoint(rest, limit)
    if (cut <= 0) cut = limit
    chunks.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest.length > 0) chunks.push(rest)
  return chunks
}

function findCutPoint(s: string, limit: number): number {
  const window = s.slice(0, limit)
  const byPara = window.lastIndexOf('\n\n')
  if (byPara >= limit * 0.5) return byPara
  const byLine = window.lastIndexOf('\n')
  if (byLine >= limit * 0.5) return byLine
  const bySentence = Math.max(
    window.lastIndexOf('。'),
    window.lastIndexOf('. '),
    window.lastIndexOf('！'),
    window.lastIndexOf('？')
  )
  if (bySentence >= limit * 0.5) return bySentence + 1
  return limit
}
