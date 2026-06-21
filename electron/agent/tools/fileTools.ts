import { promises as fs } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import {
  readFileSafe,
  IGNORED_DIRS,
  errMessage,
  buildIgnore,
  toRel,
  type FileEncoding
} from '../../services/fsService'
import { resolveAnyPath } from './paths'
import { computeLineDiff, diffHasChanges } from './diff'
import type { Tool, ToolResult } from './types'
import { READ_FILE_NAME, READ_FILE_DESCRIPTION } from '../prompts/tools/readFile'
import { LIST_DIR_NAME, LIST_DIR_DESCRIPTION } from '../prompts/tools/listDir'
import {
  WRITE_FILE_NAME,
  WRITE_FILE_DESCRIPTION,
  EDIT_FILE_NAME,
  EDIT_FILE_DESCRIPTION,
  DELETE_FILE_NAME,
  DELETE_FILE_DESCRIPTION
} from '../prompts/tools/writeFile'


const MAX_CONTENT_CHARS = 60_000

function withLineNumbers(text: string, startLine: number): string {
  const lines = text.split('\n')
  const width = String(startLine + lines.length - 1).length
  return lines
    .map((line, i) => `${String(startLine + i).padStart(width, ' ')}\t${line}`)
    .join('\n')
}

function capContent(text: string): { content: string; truncated: boolean } {
  if (text.length <= MAX_CONTENT_CHARS) return { content: text, truncated: false }
  return { content: text.slice(0, MAX_CONTENT_CHARS) + '\n…（输出已截断）', truncated: true }
}



const readFileSchema = z.object({
  path: z.string().describe('文件路径（相对工作区根或工作区内绝对路径）'),
  offset: z.number().int().positive().optional().describe('起始行（1-based）'),
  limit: z.number().int().positive().optional().describe('最多读取行数')
})
type ReadFileInput = z.infer<typeof readFileSchema>

export const readFileTool: Tool<ReadFileInput> = {
  name: READ_FILE_NAME,
  description: READ_FILE_DESCRIPTION,
  schema: readFileSchema,
  readOnly: true,
  concurrencySafe: true,
  async execute(input, ctx): Promise<ToolResult> {
    let abs: string
    try {
      abs = resolveAnyPath(ctx.workspaceRoot, input.path)
    } catch (e) {
      return { content: errMessage(e), isError: true }
    }

    const res = await readFileSafe(abs)
    if (!res.ok) return { content: res.error ?? '读取失败', isError: true }
    if (res.tooLarge) {
      return { content: '文件过大，请用 offset/limit 分段读取', isError: true }
    }
    if (res.kind === 'binary' || res.kind === 'image') {
      return { content: `无法以文本读取（${res.kind}）`, isError: true }
    }

    const full = res.content ?? ''
    const allLines = full.split('\n')
    const start = input.offset ?? 1
    const startIdx = Math.max(0, start - 1)
    const sliced =
      input.limit != null ? allLines.slice(startIdx, startIdx + input.limit) : allLines.slice(startIdx)
    
    const sliceWasCut = startIdx + sliced.length < allLines.length

    const numbered = withLineNumbers(sliced.join('\n'), start)
    const { content, truncated } = capContent(numbered)
    return { content, truncated: truncated || sliceWasCut }
  }
}



const listDirSchema = z.object({
  path: z.string().optional().describe('目录路径（相对工作区根；省略则列工作区根）')
})
type ListDirInput = z.infer<typeof listDirSchema>

export const listDirTool: Tool<ListDirInput> = {
  name: LIST_DIR_NAME,
  description: LIST_DIR_DESCRIPTION,
  schema: listDirSchema,
  readOnly: true,
  concurrencySafe: true,
  async execute(input, ctx): Promise<ToolResult> {
    let abs: string
    try {
      abs = resolveAnyPath(ctx.workspaceRoot, input.path ?? '.')
    } catch (e) {
      return { content: errMessage(e), isError: true }
    }

    let entries
    try {
      entries = await fs.readdir(abs, { withFileTypes: true })
    } catch (e) {
      return { content: errMessage(e), isError: true }
    }

    const root = ctx.workspaceRoot
    const ig = root ? await buildIgnore(root) : null
    const rows = entries
      .filter((e) => {
        if (IGNORED_DIRS.has(e.name)) return false
        if (ig && root) {
          const fullPath = join(abs, e.name)
          const isDir = e.isDirectory()
          const rel = toRel(root, fullPath) + (isDir ? '/' : '')
          if (rel && ig.ignores(rel)) return false
        }
        return true
      })
      .map((e) => ({ name: e.name, dir: e.isDirectory() }))
      .sort((a, b) => {
        if (a.dir !== b.dir) return a.dir ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      .map((e) => (e.dir ? `${e.name}/` : e.name))

    if (rows.length === 0) return { content: '(空目录)' }
    const { content, truncated } = capContent(rows.join('\n'))
    return { content, truncated }
  }
}



interface CurrentFile {
  exists: boolean
  content: string
  encoding: FileEncoding
  binary: boolean
}

async function readCurrent(abs: string): Promise<CurrentFile> {
  const res = await readFileSafe(abs)
  if (!res.ok) return { exists: false, content: '', encoding: 'utf8', binary: false }
  if (res.tooLarge) return { exists: true, content: '', encoding: 'utf8', binary: true }
  if (res.kind === 'binary' || res.kind === 'image') {
    return { exists: true, content: '', encoding: 'utf8', binary: true }
  }
  return { exists: true, content: res.content ?? '', encoding: res.encoding ?? 'utf8', binary: false }
}

const writeFileSchema = z.object({
  path: z.string().describe('文件路径（相对工作区根）'),
  content: z.string().describe('文件完整新内容')
})
type WriteFileInput = z.infer<typeof writeFileSchema>

export const writeFileTool: Tool<WriteFileInput> = {
  name: WRITE_FILE_NAME,
  description: WRITE_FILE_DESCRIPTION,
  schema: writeFileSchema,
  readOnly: false,
  concurrencySafe: false,
  producesFileChange: true,
  async execute(input, ctx): Promise<ToolResult> {
    let abs: string
    try {
      abs = resolveAnyPath(ctx.workspaceRoot, input.path)
    } catch (e) {
      return { content: errMessage(e), isError: true }
    }
    const cur = await readCurrent(abs)
    if (cur.binary) return { content: '目标是二进制/超大文件，拒绝覆盖', isError: true }

    const diff = computeLineDiff(cur.content, input.content)
    if (cur.exists && !diffHasChanges(diff)) {
      return { content: '内容无变化，未发起写入' }
    }
    return {
      content: `准备${cur.exists ? '覆盖' : '创建'} ${input.path}`,
      fileChange: {
        path: abs,
        newContent: input.content,
        encoding: cur.exists ? cur.encoding : 'utf8',
        diff,
        isCreate: !cur.exists
      }
    }
  }
}

const editFileSchema = z.object({
  path: z.string().describe('文件路径（相对工作区根）'),
  old_string: z.string().describe('要替换的原文（需精确匹配，含缩进）'),
  new_string: z.string().describe('替换后的新文本'),
  replace_all: z.boolean().optional().describe('替换全部匹配（默认仅当唯一匹配时替换）')
})
type EditFileInput = z.infer<typeof editFileSchema>

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    count++
    idx = haystack.indexOf(needle, idx + needle.length)
  }
  return count
}

function stripReadFileLineNumbers(text: string): string {
  const lines = text.split(/\r?\n/)
  if (!lines.some((line) => /^\s*\d+\t/.test(line))) return text
  return lines.map((line) => line.replace(/^\s*\d+\t/, '')).join('\n')
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))]
}

function toCrlf(text: string): string {
  return text.replace(/\r?\n/g, '\r\n')
}

function candidateNeedles(needle: string): string[] {
  const withoutLineNumbers = stripReadFileLineNumbers(needle)
  const unescaped = needle.replace(/\\r\\n/g, '\r\n').replace(/\\n/g, '\n').replace(/\\t/g, '\t')
  const unescapedWithoutLineNumbers = withoutLineNumbers
    .replace(/\\r\\n/g, '\r\n')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
  return uniqueStrings([
    needle,
    withoutLineNumbers,
    unescaped,
    unescapedWithoutLineNumbers,
    needle.replace(/\r\n/g, '\n'),
    withoutLineNumbers.replace(/\r\n/g, '\n'),
    toCrlf(needle),
    toCrlf(withoutLineNumbers),
    toCrlf(unescaped),
    toCrlf(unescapedWithoutLineNumbers)
  ])
}

function resolveNeedle(haystack: string, rawNeedle: string): { needle: string; occurrences: number } {
  for (const needle of candidateNeedles(rawNeedle)) {
    const occurrences = countOccurrences(haystack, needle)
    if (occurrences > 0) return { needle, occurrences }
  }
  return { needle: rawNeedle, occurrences: 0 }
}

function previewJson(text: string, limit = 500): string {
  const clipped = text.length > limit ? text.slice(0, limit) + '…' : text
  return JSON.stringify(clipped)
}

function editMissDiagnostics(content: string, rawNeedle: string): string {
  const candidates = candidateNeedles(rawNeedle)
  const candidateRows = candidates
    .map((needle, i) => `候选 ${i + 1}: length=${needle.length}, occurrences=${countOccurrences(content, needle)}, value=${previewJson(needle, 220)}`)
    .join('\n')
  return [
    '未在文件中找到 old_string（需精确匹配，含空白与缩进）',
    '',
    '诊断信息：',
    `文件长度: ${content.length}`,
    `old_string 长度: ${rawNeedle.length}`,
    `old_string(JSON): ${previewJson(rawNeedle)}`,
    `文件开头(JSON): ${previewJson(content)}`,
    candidateRows
  ].join('\n')
}

export const editFileTool: Tool<EditFileInput> = {
  name: EDIT_FILE_NAME,
  description: EDIT_FILE_DESCRIPTION,
  schema: editFileSchema,
  readOnly: false,
  concurrencySafe: false,
  producesFileChange: true,
  async execute(input, ctx): Promise<ToolResult> {
    let abs: string
    try {
      abs = resolveAnyPath(ctx.workspaceRoot, input.path)
    } catch (e) {
      return { content: errMessage(e), isError: true }
    }
    const cur = await readCurrent(abs)
    if (!cur.exists) return { content: `文件不存在：${input.path}`, isError: true }
    if (cur.binary) return { content: '目标是二进制/超大文件，无法编辑', isError: true }
    if (input.old_string === input.new_string) {
      return { content: 'old_string 与 new_string 相同，无需修改', isError: true }
    }

    const { needle, occurrences } = resolveNeedle(cur.content, input.old_string)
    if (occurrences === 0) {
      return { content: editMissDiagnostics(cur.content, input.old_string), isError: true }
    }
    if (occurrences > 1 && !input.replace_all) {
      return {
        content: `old_string 匹配到 ${occurrences} 处；请提供更精确的上下文，或设置 replace_all=true`,
        isError: true
      }
    }

    
    const newContent = input.replace_all
      ? cur.content.split(needle).join(input.new_string)
      : cur.content.replace(needle, () => input.new_string)

    return {
      content: `准备修改 ${input.path}`,
      fileChange: {
        path: abs,
        newContent,
        encoding: cur.encoding,
        diff: computeLineDiff(cur.content, newContent),
        isCreate: false
      }
    }
  }
}

const deleteFileSchema = z.object({
  path: z.string().describe('文件路径（相对工作区根）')
})
type DeleteFileInput = z.infer<typeof deleteFileSchema>

export const deleteFileTool: Tool<DeleteFileInput> = {
  name: DELETE_FILE_NAME,
  description: DELETE_FILE_DESCRIPTION,
  schema: deleteFileSchema,
  readOnly: false,
  concurrencySafe: false,
  destructive: true,
  async execute(input, ctx): Promise<ToolResult> {
    let abs: string
    try {
      abs = resolveAnyPath(ctx.workspaceRoot, input.path)
    } catch (e) {
      return { content: errMessage(e), isError: true }
    }
    try {
      
      await ctx.snapshot?.(abs)
      await fs.rm(abs, { recursive: false, force: false })
      return { content: `已删除 ${input.path}`, appliedPath: abs }
    } catch (e) {
      return { content: errMessage(e), isError: true }
    }
  }
}
