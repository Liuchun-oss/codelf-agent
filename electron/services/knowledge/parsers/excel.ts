// Excel 解析：用 SheetJS (xlsx) 提取所有 sheet，转成 Markdown 表格。
// 支持 .xls（老二进制格式）和 .xlsx（Office Open XML）。
// 大表格（>100 行）会按 50 行分块，每块保留表头，避免单个 chunk 过大。
import * as XLSX from 'xlsx'

const MAX_ROWS_PER_TABLE = 100 // 超过此行数时分块

// 检测第一行是否像数据行（而非表头）
function isDataRow(row: unknown[]): boolean {
  if (!row || row.length === 0) return false
  let numericCount = 0
  let dateCount = 0
  let validCount = 0

  for (const cell of row) {
    if (cell == null || String(cell).trim() === '') continue
    validCount++
    const str = String(cell).trim()
    // 纯数字（包括小数、负数）
    if (/^-?\d+(\.\d+)?$/.test(str)) {
      numericCount++
    }
    // 日期格式（yyyy-mm-dd、yyyy/mm/dd 等）
    if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(str)) {
      dateCount++
    }
  }

  // 如果 >80% 的列是数字或日期，认为是数据行
  return validCount > 0 && (numericCount + dateCount) / validCount > 0.8
}

// 把二维数组转成 Markdown 表格。
function arrayToMarkdownTable(data: unknown[][]): string {
  if (!data || data.length === 0) return ''

  // 过滤空行
  const rows = data.filter((row) => row && row.some((cell) => cell != null && String(cell).trim() !== ''))
  if (rows.length === 0) return ''

  // 确定列数（取最宽行）
  const cols = Math.max(...rows.map((r) => r.length))

  // 补齐每行到相同列数，空值填 ''
  const normalized = rows.map((row) => {
    const arr = row.map((cell) => (cell == null ? '' : String(cell).trim()))
    while (arr.length < cols) arr.push('')
    return arr
  })

  // 智能判断是否需要添加空表头
  let header: string[]
  let body: string[][]

  if (normalized.length > 0 && isDataRow(normalized[0])) {
    // 第一行是数据：添加空表头（列1、列2、...）
    header = Array.from({ length: cols }, (_, i) => `列${i + 1}`)
    body = normalized
  } else {
    // 第一行是表头：正常处理
    header = normalized[0]
    body = normalized.slice(1)
  }

  const escapedHeader = header.map((cell) => cell.replace(/\|/g, '\\|'))
  const separator = Array(cols).fill('---')
  const escapedBody = body.map((row) =>
    row.map((cell) => cell.replace(/\|/g, '\\|'))
  )

  const lines: string[] = []
  lines.push(`| ${escapedHeader.join(' | ')} |`)
  lines.push(`| ${separator.join(' | ')} |`)
  for (const row of escapedBody) {
    lines.push(`| ${row.join(' | ')} |`)
  }

  return lines.join('\n')
}

// 大表格分块：超过 MAX_ROWS_PER_TABLE 行时按 50 行切块，每块保留表头。
function chunkLargeTable(data: unknown[][]): string[] {
  if (data.length <= MAX_ROWS_PER_TABLE) {
    return [arrayToMarkdownTable(data)]
  }

  const chunks: string[] = []
  const header = data[0]
  const chunkSize = 50

  for (let i = 1; i < data.length; i += chunkSize) {
    const slice = [header, ...data.slice(i, i + chunkSize)]
    chunks.push(arrayToMarkdownTable(slice))
  }

  return chunks
}

export async function parseExcel(path: string): Promise<string> {
  const workbook = XLSX.readFile(path, { type: 'file', cellDates: true })
  const sections: string[] = []

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]
    if (!sheet) continue

    // sheet_to_json 的 header: 1 模式返回二维数组（原始行列）
    const data = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' })

    if (data.length === 0) continue

    // 大表格分块
    const chunks = chunkLargeTable(data)
    if (chunks.length === 0) continue

    // 多 sheet 用二级标题区分
    if (workbook.SheetNames.length > 1) {
      sections.push(`## ${sheetName}\n\n${chunks.join('\n\n---\n\n')}`)
    } else {
      sections.push(chunks.join('\n\n---\n\n'))
    }
  }

  return sections.join('\n\n')
}
