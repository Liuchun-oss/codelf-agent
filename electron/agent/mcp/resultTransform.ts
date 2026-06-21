// 把 MCP callTool / readResource / getPrompt 的返回内容转成纯文本，
// 以便塞进本项目统一的 ToolResult.content。

interface ContentBlock {
  type: string
  text?: string
  data?: string
  mimeType?: string
  uri?: string
  name?: string
  resource?: { uri?: string; text?: string; mimeType?: string; blob?: string }
  [key: string]: unknown
}

function blockToText(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text ?? ''
    case 'image':
      return '' // 图片由 collectImages 单独处理为多模态内容
    case 'audio':
      return `[音频内容 ${block.mimeType ?? 'audio'}，已省略 base64 数据]`
    case 'resource_link':
      return `[资源链接] ${block.name ?? ''} ${block.uri ?? ''}`.trim()
    case 'resource': {
      const r = block.resource
      if (r?.text) return r.text
      if (r?.uri) return `[嵌入资源] ${r.uri}${r.mimeType ? ` (${r.mimeType})` : ''}`
      return '[嵌入资源]'
    }
    default:
      return `[未知内容类型: ${block.type}]`
  }
}

// 从 content 块中提取图片，组装为 data URL。
function collectImages(blocks: ContentBlock[]): { dataUrl: string }[] {
  const images: { dataUrl: string }[] = []
  for (const block of blocks) {
    if (block.type === 'image' && typeof block.data === 'string' && block.data) {
      const mime = block.mimeType || 'image/png'
      images.push({ dataUrl: `data:${mime};base64,${block.data}` })
    }
  }
  return images
}

export interface McpCallResult {
  content?: unknown
  structuredContent?: unknown
  isError?: boolean
}

// 转换 callTool 结果。structuredContent 优先以 JSON 呈现，其次拼接 content 块。
export function transformToolResult(result: McpCallResult): {
  text: string
  isError: boolean
  images: { dataUrl: string }[]
} {
  const isError = result.isError === true
  const blocks = Array.isArray(result.content) ? (result.content as ContentBlock[]) : []
  const parts = blocks.map(blockToText).filter((s) => s.length > 0)
  const images = collectImages(blocks)

  if (parts.length === 0 && images.length === 0 && result.structuredContent !== undefined) {
    try {
      return { text: JSON.stringify(result.structuredContent, null, 2), isError, images }
    } catch {
      // 落回空文本
    }
  }

  const text =
    parts.length > 0
      ? parts.join('\n')
      : images.length > 0
        ? `(MCP 工具返回了 ${images.length} 张图片)`
        : '(MCP 工具未返回内容)'
  return { text, isError, images }
}

interface ResourceContent {
  uri?: string
  text?: string
  mimeType?: string
  blob?: string
}

// 转换 readResource 结果。
export function transformResourceResult(contents: ResourceContent[]): string {
  if (!Array.isArray(contents) || contents.length === 0) return '(资源为空)'
  return contents
    .map((c) => {
      if (c.text !== undefined) return c.text
      if (c.blob !== undefined) {
        return `[二进制资源 ${c.uri ?? ''}${c.mimeType ? ` (${c.mimeType})` : ''}，已省略 base64 数据]`
      }
      return `[资源 ${c.uri ?? ''}]`
    })
    .join('\n')
}

interface PromptMessage {
  role: string
  content: ContentBlock | ContentBlock[]
}

// 转换 getPrompt 结果为可读文本。
export function transformPromptResult(messages: PromptMessage[]): string {
  if (!Array.isArray(messages)) return ''
  return messages
    .map((m) => {
      const blocks = Array.isArray(m.content) ? m.content : [m.content]
      const body = blocks.map(blockToText).join('\n')
      return `${m.role}: ${body}`
    })
    .join('\n\n')
}
