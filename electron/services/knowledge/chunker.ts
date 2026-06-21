// 文档分块器：面向自然语言文档（非代码）。
// 策略：
//  - 按 Markdown 标题切分出"节"，节内按段落聚合到目标字符数，超长再切；
//  - Markdown 表格整块保留（不被段落聚合切散），避免破坏行列对应关系；
//  - 相邻块带少量重叠，缓解检索时上下文被截断的问题；
//  - 每个块记录所属标题（heading），作为来源信息回传。

export interface DocChunk {
  text: string
  // 该块所属的最近标题（用于检索结果定位），无则为空串。
  heading: string
  // 块序号（从 0 起），用于来源展示与排序。
  ordinal: number
}

const TARGET_CHARS = 1000
const MAX_CHARS = 1600
const OVERLAP_CHARS = 120

function isHeading(line: string): boolean {
  return /^#{1,6}\s+/.test(line)
}

function isTableRow(line: string): boolean {
  const t = line.trim()
  return t.startsWith('|') && t.endsWith('|') && t.length > 1
}

interface Block {
  text: string
  isTable: boolean
}

// 把一节的文本拆成"段落块"与"表格块"。表格连续行聚为一个块。
function splitBlocks(body: string): Block[] {
  const lines = body.split(/\r\n|\r|\n/)
  const blocks: Block[] = []
  let para: string[] = []
  let table: string[] = []

  const flushPara = (): void => {
    const text = para.join('\n').trim()
    if (text) blocks.push({ text, isTable: false })
    para = []
  }
  const flushTable = (): void => {
    const text = table.join('\n').trim()
    if (text) blocks.push({ text, isTable: true })
    table = []
  }

  for (const line of lines) {
    if (isTableRow(line)) {
      if (para.length) flushPara()
      table.push(line)
      continue
    }
    if (table.length) flushTable()
    if (line.trim() === '') {
      if (para.length) flushPara()
    } else {
      para.push(line)
    }
  }
  if (para.length) flushPara()
  if (table.length) flushTable()
  return blocks
}

// 从文本尾部取重叠片段：优先按换行符边界，其次按句子标点，最后才硬切字符数。
// 目的：避免切到中文句子/标点中间，让重叠部分更完整。
function tailOverlap(text: string): string {
  if (text.length <= OVERLAP_CHARS) return text
  const slice = text.slice(text.length - OVERLAP_CHARS)

  // 1. 优先：找换行符
  const nl = slice.indexOf('\n')
  if (nl >= 0) return slice.slice(nl + 1)

  // 2. 次选：找中文句号、问号、感叹号等句子边界（从后往前找最后一个）
  const sentenceEnd = /[。！？；;!?.]\s*/g
  let lastMatch = -1
  let m: RegExpExecArray | null
  while ((m = sentenceEnd.exec(slice))) {
    lastMatch = m.index + m[0].length
  }
  if (lastMatch > 0 && lastMatch < slice.length) {
    return slice.slice(lastMatch)
  }

  // 3. 兜底：找逗号
  const lastComma = Math.max(slice.lastIndexOf('，'), slice.lastIndexOf(','))
  if (lastComma > 0 && lastComma < slice.length - 1) {
    return slice.slice(lastComma + 1)
  }

  // 4. 实在找不到边界，返回整个 slice（硬切）
  return slice
}

// 把一节（heading + blocks）聚合成目标大小的块。
function chunkSection(heading: string, blocks: Block[], out: DocChunk[]): void {
  let buf = ''
  const push = (text: string): void => {
    const trimmed = text.trim()
    if (trimmed) out.push({ text: trimmed, heading, ordinal: out.length })
  }

  for (const block of blocks) {
    // 表格整块独立成块（可能超过 MAX_CHARS，但保结构优先）。
    if (block.isTable) {
      if (buf) {
        push(buf)
        buf = ''
      }
      const prefix = heading ? `${heading}\n` : ''
      push(prefix + block.text)
      continue
    }

    if (block.text.length > MAX_CHARS) {
      if (buf) {
        push(buf)
        buf = ''
      }
      // 超长段落按字符硬切，带重叠。
      let i = 0
      while (i < block.text.length) {
        const piece = block.text.slice(i, i + TARGET_CHARS)
        push(piece)
        i += TARGET_CHARS - OVERLAP_CHARS
      }
      continue
    }

    if (buf && buf.length + block.text.length + 1 > TARGET_CHARS) {
      push(buf)
      buf = tailOverlap(buf) + '\n' + block.text
    } else {
      buf = buf ? `${buf}\n${block.text}` : block.text
    }
  }
  if (buf) push(buf)
}

// 把整篇文档（已转 Markdown）切成块。
export function chunkDocument(content: string): DocChunk[] {
  const lines = content.split(/\r\n|\r|\n/)
  const out: DocChunk[] = []

  let currentHeading = ''
  let sectionLines: string[] = []

  const flushSection = (): void => {
    if (sectionLines.length === 0) return
    const blocks = splitBlocks(sectionLines.join('\n'))
    if (blocks.length) chunkSection(currentHeading, blocks, out)
    sectionLines = []
  }

  for (const line of lines) {
    if (isHeading(line)) {
      flushSection()
      currentHeading = line.replace(/^#{1,6}\s+/, '').trim()
    } else {
      sectionLines.push(line)
    }
  }
  flushSection()

  // 重新编号 ordinal，保证全局连续。
  return out.map((c, i) => ({ ...c, ordinal: i }))
}
