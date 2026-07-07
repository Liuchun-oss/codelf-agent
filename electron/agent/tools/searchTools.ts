import { z } from 'zod'
import { searchInFiles, searchCodebase } from '../../services/searchService'
import { semanticSearch } from '../../services/semantic/indexer'
import { errMessage } from '../../services/fsService'
import { resolveAnyPath } from './paths'
import type { Tool, ToolResult } from './types'
import { GREP_NAME, GREP_DESCRIPTION } from '../prompts/tools/grep'
import { CODEBASE_SEARCH_NAME, CODEBASE_SEARCH_DESCRIPTION } from '../prompts/tools/codebaseSearch'

const MAX_CONTENT_CHARS = 60_000

const grepSchema = z.object({
  query: z.string().min(1).describe('搜索内容（默认字面量；regex=true 时为正则）'),
  path: z.string().optional().describe('限定子目录（相对工作区根）'),
  regex: z.boolean().optional(),
  caseSensitive: z.boolean().optional()
})
type GrepInput = z.infer<typeof grepSchema>

export const grepTool: Tool<GrepInput> = {
  name: GREP_NAME,
  description: GREP_DESCRIPTION,
  schema: grepSchema,
  readOnly: true,
  concurrencySafe: true,
  async execute(input, ctx): Promise<ToolResult> {
    if (!ctx.workspaceRoot) return { content: '未打开工作区', isError: true }

    let searchRoot = ctx.workspaceRoot
    if (input.path) {
      try {
        searchRoot = resolveAnyPath(ctx.workspaceRoot, input.path)
      } catch (e) {
        return { content: errMessage(e), isError: true }
      }
    }

    const res = await searchInFiles(searchRoot, input.query, {
      regex: input.regex,
      caseSensitive: input.caseSensitive
    })
    if (!res.ok) return { content: res.error ?? '搜索失败', isError: true }

    // 附注：超大文件跳过 / 达时间上限。这些信息必须透出，否则模型会把"被跳过/超时"
    // 误判为"内容不存在"，做出错误结论（这正是此前 grep"经常失败"的隐性根源）。
    const notes: string[] = []
    if (res.skippedLargeFiles?.length) {
      const shown = res.skippedLargeFiles.slice(0, 10).join('、')
      const more = res.skippedLargeFiles.length > 10 ? ` 等 ${res.skippedLargeFiles.length} 个` : ''
      notes.push(
        `注意：${res.skippedLargeFiles.length} 个文件因超过大小上限(32MB)未被搜索：${shown}${more}。` +
          `如需在其中查找，请用 read_file 或终端命令(rg/grep)针对性搜索。`
      )
    }
    if (res.timedOut) {
      notes.push('注意：搜索因达到时间上限提前结束，结果可能不完整，请缩小 path 范围或细化查询后重试。')
    }
    const noteBlock = notes.length ? notes.join('\n') + '\n' : ''

    if (res.results.length === 0) {
      return { content: noteBlock ? `${noteBlock}无匹配结果` : '无匹配结果' }
    }

    const lines: string[] = []
    let matchCount = 0
    for (const file of res.results) {
      for (const m of file.matches) {
        lines.push(`${file.path}:${m.line}:${m.col}: ${m.preview}`)
        matchCount++
      }
    }

    let body = lines.join('\n')
    let truncated = res.truncated
    if (body.length > MAX_CONTENT_CHARS) {
      body = body.slice(0, MAX_CONTENT_CHARS) + '\n…（结果已截断）'
      truncated = true
    }
    const header = `找到 ${matchCount} 处匹配${res.truncated ? '（已达上限）' : ''}：\n`
    return { content: noteBlock + header + body, truncated }
  }
}

const codebaseSearchSchema = z.object({
  query: z.string().min(1).describe('Natural-language or keyword query (e.g. "user authentication login")')
})
type CodebaseSearchInput = z.infer<typeof codebaseSearchSchema>

export const codebaseSearchTool: Tool<CodebaseSearchInput> = {
  name: CODEBASE_SEARCH_NAME,
  description: CODEBASE_SEARCH_DESCRIPTION,
  schema: codebaseSearchSchema,
  readOnly: true,
  concurrencySafe: true,
  async execute(input, ctx): Promise<ToolResult> {
    if (!ctx.workspaceRoot) return { content: '未打开工作区', isError: true }

    // 优先使用语义索引（embedding）；索引不存在或失败时回退到关键词检索。
    try {
      const sem = await semanticSearch(ctx.workspaceRoot, input.query)
      if (sem.ok && sem.indexed && sem.hits.length > 0) {
        const lines: string[] = []
        for (const hit of sem.hits) {
          lines.push(`# ${hit.path}:${hit.startLine}-${hit.endLine}  (相关度 ${hit.score.toFixed(3)})`)
          const preview = hit.text.length > 600 ? hit.text.slice(0, 600) + '…' : hit.text
          for (const l of preview.split('\n')) lines.push(`    ${l}`)
        }
        const header = `相关代码片段（语义检索，按相关度排序，共 ${sem.hits.length} 段）：\n`
        let body = lines.join('\n')
        let truncated = false
        if (body.length > MAX_CONTENT_CHARS) {
          body = body.slice(0, MAX_CONTENT_CHARS) + '\n…（结果已截断）'
          truncated = true
        }
        return { content: header + body, truncated }
      }
    } catch {
      // 语义检索不可用时静默回退。
    }

    const res = await searchCodebase(ctx.workspaceRoot, input.query)
    if (!res.ok) return { content: res.error ?? '搜索失败', isError: true }
    if (res.hits.length === 0) return { content: '未找到相关文件' }

    const lines: string[] = []
    for (const hit of res.hits) {
      lines.push(`# ${hit.path}  (score ${hit.score})`)
      for (const s of hit.snippets) lines.push(`    ${s}`)
    }
    const header = `相关文件（按相关性排序，共 ${res.hits.length} 个${res.truncated ? '，结果较多已截断' : ''}）：\n`
    return { content: header + lines.join('\n'), truncated: res.truncated }
  }
}
