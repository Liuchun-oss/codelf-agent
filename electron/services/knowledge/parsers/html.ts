// 把 mammoth 输出的 docx HTML 转成 Markdown 文本。
// 重点：保留表格的行列结构（转成 Markdown 表格），标题、列表也尽量保形，
// 让后续分块与 embedding 能利用文档结构，大模型也最擅长读 Markdown。
//
// 注意：Markdown 表格要求有 header 行，这里强制把第一行当表头。
// 如果原表格第一行不是标题行，会导致第一行数据被误当表头，但这是 Markdown 格式限制。

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
}

// 检测第一行是否像数据行（而非表头）
function isDataRow(cells: string[]): boolean {
  if (!cells || cells.length === 0) return false
  let numericCount = 0
  let dateCount = 0
  let validCount = 0

  for (const cell of cells) {
    if (cell.trim() === '') continue
    validCount++
    // 纯数字（包括小数、负数）
    if (/^-?\d+(\.\d+)?$/.test(cell)) {
      numericCount++
    }
    // 日期格式
    if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(cell)) {
      dateCount++
    }
  }

  // 如果 >80% 的列是数字或日期，认为是数据行
  return validCount > 0 && (numericCount + dateCount) / validCount > 0.8
}

// 把单个 <table>…</table> 片段转成 Markdown 表格。
function tableToMarkdown(tableHtml: string): string {
  const rows: string[][] = []
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
  let rowMatch: RegExpExecArray | null
  while ((rowMatch = rowRe.exec(tableHtml))) {
    const cells: string[] = []
    const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi
    let cellMatch: RegExpExecArray | null
    while ((cellMatch = cellRe.exec(rowMatch[1]))) {
      cells.push(stripTags(cellMatch[1]).replace(/\|/g, '\\|'))
    }
    if (cells.length > 0) rows.push(cells)
  }
  if (rows.length === 0) return ''

  const cols = Math.max(...rows.map((r) => r.length))
  const pad = (r: string[]): string[] => {
    const copy = [...r]
    while (copy.length < cols) copy.push('')
    return copy
  }

  const lines: string[] = []

  // 智能判断是否需要添加空表头
  let header: string[]
  let bodyStart: number

  if (rows.length > 0 && isDataRow(rows[0])) {
    // 第一行是数据：添加空表头
    header = Array.from({ length: cols }, (_, i) => `列${i + 1}`)
    bodyStart = 0
  } else {
    // 第一行是表头：正常处理
    header = pad(rows[0])
    bodyStart = 1
  }

  lines.push(`| ${header.join(' | ')} |`)
  lines.push(`| ${Array(cols).fill('---').join(' | ')} |`)
  for (let i = bodyStart; i < rows.length; i++) {
    lines.push(`| ${pad(rows[i]).join(' | ')} |`)
  }
  return lines.join('\n')
}

// 极简 HTML→Markdown：先抽出表格单独处理，其余块级元素转成段落/标题/列表。
export function htmlToMarkdown(html: string): string {
  const parts: string[] = []
  let lastIndex = 0
  const tableRe = /<table[^>]*>[\s\S]*?<\/table>/gi
  let m: RegExpExecArray | null
  while ((m = tableRe.exec(html))) {
    parts.push(blocksToMarkdown(html.slice(lastIndex, m.index)))
    parts.push(tableToMarkdown(m[0]))
    lastIndex = m.index + m[0].length
  }
  parts.push(blocksToMarkdown(html.slice(lastIndex)))
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join('\n\n')
}

function blocksToMarkdown(html: string): string {
  const out: string[] = []
  const blockRe = /<(h[1-6]|p|li)[^>]*>([\s\S]*?)<\/\1>/gi
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(html))) {
    const tag = m[1].toLowerCase()
    const text = stripTags(m[2])
    if (!text) continue
    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag[1])
      out.push(`${'#'.repeat(level)} ${text}`)
    } else if (tag === 'li') {
      out.push(`- ${text}`)
    } else {
      out.push(text)
    }
  }
  // 没有任何块级标签时，退化为纯文本。
  if (out.length === 0) {
    const fallback = stripTags(html)
    if (fallback) out.push(fallback)
  }
  return out.join('\n\n')
}
