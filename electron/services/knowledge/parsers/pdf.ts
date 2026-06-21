// PDF 解析：用 pdfjs-dist 提取每页文本项（带坐标），先按 y 聚成行，
// 再用列边界启发式检测"疑似表格区域"还原成 Markdown 表格，其余按段落输出。
// 仅处理文本型 PDF；扫描件（无文本层）会得到空内容，由上层判定跳过。
//
// 表格识别启发式：连续多行（≥2）具有 ≥3 列结构则认定为表格。
// 局限性：单列表格、不规则表格可能误判为段落。复杂表格建议转 docx 导入。
import { pathToFileURL } from 'url'

interface TextItem {
  str: string
  x: number
  y: number
  w: number
}

interface Cell {
  x: number
  text: string
}

interface Line {
  y: number
  cells: Cell[]
}

// 同一行的 y 容差（pt）。
const ROW_TOL = 3
// 判定为"列间隔"的最小水平间距（pt）。
const COL_GAP = 18
// 连续多少行具有相近的多列结构才认定为表格（修改为 2 以支持双列表格）。
const MIN_TABLE_ROWS = 2
// 最少列数：≥2 列才可能是表格（支持双列表格如"名称 | 说明"）。
const MIN_TABLE_COLS = 2

// 解析 worker 文件路径并转成 file:// URL。
// Windows 下 pdfjs 的 ESM fake-worker 加载器要求 file:// URL，不能用裸 d:\ 路径。
function resolveWorkerSrc(): string {
  const p = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
  return pathToFileURL(p).href
}

function buildLines(items: TextItem[]): Line[] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x)
  const lines: Line[] = []
  for (const it of sorted) {
    if (!it.str.trim()) continue
    const line = lines.find((l) => Math.abs(l.y - it.y) <= ROW_TOL)
    if (line) {
      line.cells.push({ x: it.x, text: it.str })
    } else {
      lines.push({ y: it.y, cells: [{ x: it.x, text: it.str }] })
    }
  }
  // 行内按 x 排序，并把间距很近的片段合并为同一单元格。
  for (const l of lines) {
    l.cells.sort((a, b) => a.x - b.x)
    const merged: Cell[] = []
    for (const c of l.cells) {
      const last = merged[merged.length - 1]
      if (last && c.x - (last.x) < COL_GAP) {
        last.text = `${last.text} ${c.text}`.trim()
      } else {
        merged.push({ ...c })
      }
    }
    l.cells = merged
  }
  return lines
}

function rowToParagraph(line: Line): string {
  return line.cells.map((c) => c.text).join(' ').trim()
}

function cellsToMarkdownRow(cells: string[]): string {
  return `| ${cells.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`
}

// 把一段连续的多列行渲染成 Markdown 表格。
function renderTable(rows: Line[]): string {
  const cols = Math.max(...rows.map((r) => r.cells.length))
  const pad = (r: Line): string[] => {
    const arr = r.cells.map((c) => c.text)
    while (arr.length < cols) arr.push('')
    return arr
  }
  const out: string[] = []
  out.push(cellsToMarkdownRow(pad(rows[0])))
  out.push(`| ${Array(cols).fill('---').join(' | ')} |`)
  for (let i = 1; i < rows.length; i++) out.push(cellsToMarkdownRow(pad(rows[i])))
  return out.join('\n')
}

// 把一页的行序列转成 Markdown：连续的多列行聚为表格，其余为段落。
function linesToMarkdown(lines: Line[]): string {
  const blocks: string[] = []
  let tableBuf: Line[] = []

  const flushTable = (): void => {
    if (tableBuf.length >= MIN_TABLE_ROWS) {
      blocks.push(renderTable(tableBuf))
    } else {
      for (const l of tableBuf) {
        const p = rowToParagraph(l)
        if (p) blocks.push(p)
      }
    }
    tableBuf = []
  }

  for (const line of lines) {
    const isMultiCol = line.cells.length >= MIN_TABLE_COLS
    if (isMultiCol) {
      tableBuf.push(line)
    } else {
      flushTable()
      const p = rowToParagraph(line)
      if (p) blocks.push(p)
    }
  }
  flushTable()
  return blocks.join('\n\n')
}

export async function parsePdf(path: string): Promise<string> {
  // pdfjs-dist v6 为纯 ESM，主进程是 CJS，用动态 import 加载 legacy 构建。
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  // Node/Electron 无浏览器 Worker：把 workerSrc 指向 legacy worker 文件，
  // pdfjs 会以 fake worker 在主线程运行（不指定会直接抛错）。
  try {
    const gwo = pdfjs.GlobalWorkerOptions as { workerSrc: string }
    gwo.workerSrc = resolveWorkerSrc()
  } catch {
    // ignore：交给 pdfjs 默认行为。
  }
  const { readFile } = await import('fs/promises')
  const data = new Uint8Array(await readFile(path))
  const loadingTask = pdfjs.getDocument({ data, useSystemFonts: true })
  const doc = await loadingTask.promise

  const pages: string[] = []
  let hasText = false

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    const items: TextItem[] = []
    for (const it of content.items as Array<{ str?: string; transform?: number[]; width?: number }>) {
      if (typeof it.str !== 'string' || !it.transform) continue
      if (it.str.trim()) hasText = true  // 检测是否有文本
      items.push({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width ?? 0 })
    }
    const md = linesToMarkdown(buildLines(items))
    if (md.trim()) pages.push(md)
    page.cleanup()
  }
  await loadingTask.destroy()

  const result = pages.join('\n\n')

  // 如果 PDF 完全没有文本（扫描件），抛错附带提示
  if (!hasText || !result.trim()) {
    throw new Error('扫描件 PDF 无文本层，无法提取内容。建议使用 OCR 工具转换后重新导入。')
  }

  return result
}
