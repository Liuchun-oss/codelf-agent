import { z } from 'zod'
import { readFileSafe, type FileEncoding } from '../../services/fsService'
import { computeLineDiff, diffHasChanges } from './diff'
import { resolveAnyPath } from './paths'
import type { Tool, ToolResult } from './types'
import { NOTEBOOK_EDIT_DESCRIPTION, NOTEBOOK_EDIT_NAME } from '../prompts/tools/notebookEdit'

const notebookEditSchema = z.object({
  path: z.string().describe('Path to a .ipynb notebook inside the workspace'),
  cell_idx: z.number().int().min(0).describe('Zero-based cell index to edit or insert at'),
  is_new_cell: z.boolean().describe('If true, insert a new cell at cell_idx; otherwise edit the existing cell'),
  cell_language: z
    .enum(['python', 'markdown', 'javascript', 'typescript', 'r', 'sql', 'shell', 'raw', 'other'])
    .describe('Language/type for the cell'),
  old_string: z.string().describe('Exact text to replace in the existing cell; ignored for new cells'),
  new_string: z.string().describe('Replacement cell text, or new cell contents')
})

type NotebookEditInput = z.infer<typeof notebookEditSchema>

type NotebookCell = {
  cell_type?: string
  source?: string | string[]
  metadata?: Record<string, unknown>
  execution_count?: number | null
  outputs?: unknown[]
}

type NotebookDocument = {
  cells?: NotebookCell[]
  metadata?: Record<string, unknown>
  nbformat?: number
  nbformat_minor?: number
}

function sourceToString(source: string | string[] | undefined): string {
  if (Array.isArray(source)) return source.join('')
  return source ?? ''
}

function stringToSource(text: string): string[] {
  if (text.length === 0) return []
  const lines = text.split(/(?<=\n)/)
  return lines
}

function cellTypeFor(language: NotebookEditInput['cell_language']): string {
  if (language === 'markdown') return 'markdown'
  if (language === 'raw') return 'raw'
  return 'code'
}

function newCell(input: NotebookEditInput): NotebookCell {
  const cellType = cellTypeFor(input.cell_language)
  const base: NotebookCell = {
    cell_type: cellType,
    metadata: {},
    source: stringToSource(input.new_string)
  }
  if (cellType === 'code') {
    base.execution_count = null
    base.outputs = []
  }
  return base
}

function readNotebookJson(content: string): NotebookDocument | { error: string } {
  try {
    const parsed = JSON.parse(content) as NotebookDocument
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.cells)) {
      return { error: 'Notebook JSON 缺少 cells 数组' }
    }
    return parsed
  } catch {
    return { error: 'Notebook JSON 解析失败' }
  }
}

async function readNotebook(abs: string): Promise<{ content: string; encoding: FileEncoding } | { error: string }> {
  const res = await readFileSafe(abs)
  if (!res.ok) return { error: res.error ?? '读取 notebook 失败' }
  if (res.tooLarge) return { error: 'Notebook 文件过大，拒绝编辑' }
  if (res.kind === 'binary' || res.kind === 'image') return { error: '目标不是文本 notebook' }
  return { content: res.content ?? '', encoding: res.encoding ?? 'utf8' }
}

export const notebookEditTool: Tool<NotebookEditInput> = {
  name: NOTEBOOK_EDIT_NAME,
  description: NOTEBOOK_EDIT_DESCRIPTION,
  schema: notebookEditSchema,
  readOnly: false,
  concurrencySafe: false,
  producesFileChange: true,
  async execute(input, ctx): Promise<ToolResult> {
    if (!input.path.toLowerCase().endsWith('.ipynb')) {
      return { content: 'NotebookEdit 只支持 .ipynb 文件', isError: true }
    }

    let abs: string
    try {
      abs = resolveAnyPath(ctx.workspaceRoot, input.path)
    } catch (e) {
      return { content: e instanceof Error ? e.message : '路径无效', isError: true }
    }

    const current = await readNotebook(abs)
    if ('error' in current) return { content: current.error, isError: true }

    const notebook = readNotebookJson(current.content)
    if ('error' in notebook) return { content: notebook.error, isError: true }

    if (!notebook.cells) return { content: 'Notebook JSON 缺少 cells 数组', isError: true }

    if (input.is_new_cell) {
      if (input.cell_idx > notebook.cells.length) {
        return { content: `cell_idx 越界：${input.cell_idx}`, isError: true }
      }
      notebook.cells.splice(input.cell_idx, 0, newCell(input))
    } else {
      const cell = notebook.cells[input.cell_idx]
      if (!cell) return { content: `cell_idx 越界：${input.cell_idx}`, isError: true }
      const source = sourceToString(cell.source)
      const occurrences = input.old_string ? source.split(input.old_string).length - 1 : 0
      if (occurrences === 0) return { content: 'old_string 在目标 cell 中未找到', isError: true }
      if (occurrences > 1) return { content: 'old_string 在目标 cell 中出现多次；请提供更具体的上下文', isError: true }
      cell.source = stringToSource(source.replace(input.old_string, input.new_string))
    }

    const nextContent = JSON.stringify(notebook, null, 2) + '\n'
    const diff = computeLineDiff(current.content, nextContent)
    if (!diffHasChanges(diff)) return { content: 'Notebook 内容无变化，未发起写入' }

    return {
      content: `准备编辑 notebook ${input.path} 的 cell #${input.cell_idx}`,
      fileChange: {
        path: abs,
        newContent: nextContent,
        encoding: current.encoding,
        diff,
        isCreate: false
      }
    }
  }
}
