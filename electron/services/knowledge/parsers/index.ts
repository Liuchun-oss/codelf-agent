import { promises as fs } from 'fs'
import { extname } from 'path'
import { htmlToMarkdown } from './html'
import { parsePdf } from './pdf'
import { parseDoc } from './doc'
import { parseExcel } from './excel'

export interface ParsedDoc {
  // 解析后的纯文本/Markdown 内容（表格已转 Markdown）。
  text: string
  // 文档标题（取首个非空行或文件名，调用方决定）。
  title?: string
  // 特殊提示信息（如老格式建议转换等）。
  warning?: string
}

// 支持的文档扩展名。
export const SUPPORTED_EXTS = new Set(['.docx', '.pdf', '.doc', '.xls', '.xlsx', '.md', '.markdown', '.txt'])

export function isSupportedDoc(path: string): boolean {
  return SUPPORTED_EXTS.has(extname(path).toLowerCase())
}

async function parseDocx(path: string): Promise<ParsedDoc> {
  // mammoth 输出 HTML（保留表格/标题），再转 Markdown。
  const mammoth = await import('mammoth')
  const buffer = await fs.readFile(path)
  const result = await mammoth.convertToHtml({ buffer })
  return { text: htmlToMarkdown(result.value) }
}

async function parsePlainText(path: string): Promise<ParsedDoc> {
  const text = await fs.readFile(path, 'utf8')
  return { text }
}

// 按扩展名分发解析；不支持的格式抛错由上层捕获并记录。
export async function parseDocument(path: string): Promise<ParsedDoc> {
  const ext = extname(path).toLowerCase()
  switch (ext) {
    case '.docx':
      return parseDocx(path)
    case '.pdf':
      return { text: await parsePdf(path) }
    case '.doc':
      return {
        text: await parseDoc(path),
        warning: '老式 .doc 格式无法保留表格结构，建议用 Word/LibreOffice 另存为 .docx 后重新导入'
      }
    case '.xls':
    case '.xlsx':
      return { text: await parseExcel(path) }
    case '.md':
    case '.markdown':
    case '.txt':
      return parsePlainText(path)
    default:
      throw new Error(`暂不支持的文档格式：${ext || '(无扩展名)'}`)
  }
}
