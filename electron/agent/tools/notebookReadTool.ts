import { z } from 'zod'
import { readFileSafe } from '../../services/fsService'
import { resolveAnyPath } from './paths'
import type { Tool, ToolResult } from './types'
import { NOTEBOOK_READ_DESCRIPTION, NOTEBOOK_READ_NAME } from '../prompts/tools/notebookRead'

const MAX_OUTPUT_CHARS = 60_000

const notebookReadSchema = z.object({
  path: z.string().describe('Path to a .ipynb notebook inside the workspace'),
  include_outputs: z.boolean().optional().describe('Whether to include compact cell outputs'),
  cell_idx: z.number().int().min(0).optional().describe('If provided, return only this zero-based cell index')
})

type NotebookReadInput = z.infer<typeof notebookReadSchema>

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

function languageFor(cell: NotebookCell): string {
  const metadata = cell.metadata
  const language = metadata?.language
  if (typeof language === 'string' && language.trim()) return language
  const name = metadata?.name
  if (typeof name === 'string' && name.trim()) return name
  return cell.cell_type === 'markdown' ? 'markdown' : cell.cell_type === 'raw' ? 'raw' : 'python'
}

function compactOutput(output: unknown): string {
  if (!output || typeof output !== 'object') return String(output)
  const record = output as Record<string, unknown>
  const outputType = typeof record.output_type === 'string' ? record.output_type : 'output'
  const text = record.text
  if (typeof text === 'string') return `${outputType}: ${text}`
  if (Array.isArray(text)) return `${outputType}: ${text.join('')}`
  const data = record.data
  if (data && typeof data === 'object') {
    const dataRecord = data as Record<string, unknown>
    const plain = dataRecord['text/plain']
    if (typeof plain === 'string') return `${outputType}: ${plain}`
    if (Array.isArray(plain)) return `${outputType}: ${plain.join('')}`
    return `${outputType}: ${Object.keys(dataRecord).join(', ')}`
  }
  const name = record.name
  const value = record.value
  if (typeof name === 'string' && typeof value === 'string') return `${outputType}: ${name}: ${value}`
  return outputType
}

function cap(text: string): { content: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT_CHARS) return { content: text, truncated: false }
  return { content: text.slice(0, MAX_OUTPUT_CHARS) + '\n…（输出已截断）', truncated: true }
}

function renderCell(cell: NotebookCell, idx: number, includeOutputs: boolean): string {
  const type = cell.cell_type ?? 'unknown'
  const language = languageFor(cell)
  const header = `# Cell ${idx} [${type}${type === 'code' ? `:${language}` : ''}]`
  const source = sourceToString(cell.source)
  const parts = [header, source.length ? source : '(empty)']
  if (includeOutputs && cell.outputs?.length) {
    parts.push('## Outputs')
    parts.push(cell.outputs.map((output, outputIdx) => `[${outputIdx}] ${compactOutput(output)}`).join('\n'))
  }
  return parts.join('\n')
}

function parseNotebook(content: string): NotebookDocument | { error: string } {
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

export const notebookReadTool: Tool<NotebookReadInput> = {
  name: NOTEBOOK_READ_NAME,
  description: NOTEBOOK_READ_DESCRIPTION,
  schema: notebookReadSchema,
  readOnly: true,
  concurrencySafe: true,
  async execute(input, ctx): Promise<ToolResult> {
    if (!input.path.toLowerCase().endsWith('.ipynb')) {
      return { content: 'NotebookRead 只支持 .ipynb 文件', isError: true }
    }

    let abs: string
    try {
      abs = resolveAnyPath(ctx.workspaceRoot, input.path)
    } catch (e) {
      return { content: e instanceof Error ? e.message : '路径无效', isError: true }
    }

    const res = await readFileSafe(abs)
    if (!res.ok) return { content: res.error ?? '读取 notebook 失败', isError: true }
    if (res.tooLarge) return { content: 'Notebook 文件过大，请拆分或手动检查', isError: true }
    if (res.kind === 'binary' || res.kind === 'image') return { content: '目标不是文本 notebook', isError: true }

    const notebook = parseNotebook(res.content ?? '')
    if ('error' in notebook) return { content: notebook.error, isError: true }
    const cells = notebook.cells ?? []
    const selectedCells = input.cell_idx == null ? cells.map((cell, idx) => ({ cell, idx })) : [{ cell: cells[input.cell_idx], idx: input.cell_idx }]

    if (selectedCells.some((entry) => !entry.cell)) {
      return { content: `cell_idx 越界：${input.cell_idx}`, isError: true }
    }

    const intro = `Notebook: ${input.path}\nnbformat: ${notebook.nbformat ?? '?'}.${notebook.nbformat_minor ?? '?'}\ncells: ${cells.length}`
    const rendered = selectedCells.map(({ cell, idx }) => renderCell(cell, idx, input.include_outputs === true)).join('\n\n---\n\n')
    const capped = cap(`${intro}\n\n${rendered}`)
    return { content: capped.content, truncated: capped.truncated }
  }
}
