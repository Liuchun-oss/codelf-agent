import { z } from 'zod'
import { readFileSafe, errMessage, encodeTextStrict, type FileEncoding } from '../../services/fsService'
import { computeLineDiff, diffHasChanges } from './diff'
import { resolveAnyPath } from './paths'
import type { Tool, ToolResult } from './types'
import { MULTI_EDIT_DESCRIPTION, MULTI_EDIT_NAME } from '../prompts/tools/multiEdit'

const multiEditItemSchema = z.object({
  old_string: z.string().min(1).describe('Exact text to replace, including whitespace and indentation'),
  new_string: z.string().describe('Replacement text'),
  replace_all: z.boolean().optional().describe('Replace every occurrence of old_string for this edit')
})

const multiEditSchema = z.object({
  path: z.string().describe('File path relative to the workspace root'),
  edits: z.array(multiEditItemSchema).min(1).max(50).describe('Sequential edits to apply to this file')
})

type MultiEditInput = z.infer<typeof multiEditSchema>

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

async function readTextFile(abs: string): Promise<
  | { exists: true; content: string; encoding: FileEncoding }
  | { exists: false; error: string }
> {
  const res = await readFileSafe(abs)
  if (!res.ok) return { exists: false, error: res.error ?? '读取失败' }
  if (res.tooLarge) return { exists: false, error: '文件过大，无法批量编辑' }
  if (res.kind === 'binary' || res.kind === 'image') return { exists: false, error: '目标是二进制/图片文件，无法批量编辑' }
  return { exists: true, content: res.content ?? '', encoding: res.encoding ?? 'utf8' }
}

export const multiEditTool: Tool<MultiEditInput> = {
  name: MULTI_EDIT_NAME,
  description: MULTI_EDIT_DESCRIPTION,
  schema: multiEditSchema,
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

    const current = await readTextFile(abs)
    if (!current.exists) return { content: current.error, isError: true }

    let nextContent = current.content
    for (let i = 0; i < input.edits.length; i++) {
      const edit = input.edits[i]
      if (edit.old_string === edit.new_string) {
        return { content: `第 ${i + 1} 个 edit 的 old_string 与 new_string 相同`, isError: true }
      }

      const { needle, occurrences } = resolveNeedle(nextContent, edit.old_string)
      if (occurrences === 0) {
        return { content: `第 ${i + 1} 个 edit 未找到 old_string；前面的 edits 已按顺序影响后续匹配`, isError: true }
      }
      if (occurrences > 1 && !edit.replace_all) {
        return {
          content: `第 ${i + 1} 个 edit 匹配到 ${occurrences} 处；请提供更具体的上下文，或设置 replace_all=true`,
          isError: true
        }
      }

      nextContent = edit.replace_all
        ? nextContent.split(needle).join(edit.new_string)
        : nextContent.replace(needle, () => edit.new_string)
    }

    const diff = computeLineDiff(current.content, nextContent)
    if (!diffHasChanges(diff)) return { content: '内容无变化，未发起写入' }

    // 编码一致性闸门：新内容必须能用原文件编码无损表示，否则拒绝写入以避免乱码。
    if (!encodeTextStrict(nextContent, current.encoding).ok) {
      return {
        content:
          `写入被拒绝：新内容包含无法用原文件编码（${current.encoding}）表示的字符，强行写入会导致乱码。` +
          `如确需这些字符，请先征得用户同意将文件转为 UTF-8 后再改。（本次未做任何写入）`,
        isError: true
      }
    }

    return {
      content: `准备对 ${input.path} 应用 ${input.edits.length} 个编辑`,
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
