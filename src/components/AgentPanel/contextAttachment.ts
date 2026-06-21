import type { ContextAttachment } from '@shared/agentTypes'
import { pathsEqual } from '@/utils/path'
import { toast } from '@/stores/toastStore'


export const MAX_CONTEXT_ATTACHMENTS = 8


export function appendAttachment(
  list: ContextAttachment[],
  next: ContextAttachment
): ContextAttachment[] {
  if (!next.path) return list
  const nextPath = next.path
  if (list.some((a) => a.path != null && pathsEqual(a.path, nextPath))) {
    toast.warn('该文件已在上下文中')
    return list
  }
  if (list.length >= MAX_CONTEXT_ATTACHMENTS) {
    toast.warn(`最多附加 ${MAX_CONTEXT_ATTACHMENTS} 个文件`)
    return list
  }
  return [...list, next]
}


export async function loadFileAttachment(absPath: string): Promise<ContextAttachment | null> {
  const res = await window.lc.readFileSafe(absPath)
  if (!res.ok) {
    toast.error(res.error ?? '无法读取文件')
    return null
  }
  if (res.kind === 'binary') {
    toast.warn('二进制文件不能作为 @ 上下文')
    return null
  }
  if (res.kind === 'image') {
    toast.warn('图片请粘贴到支持视觉的模型；@ 仅附加文本文件')
    return null
  }
  if (res.tooLarge || !res.content) {
    toast.warn('文件过大，无法附加（超过 16MB 文本限制）')
    return null
  }
  return { kind: 'file', path: absPath, content: res.content }
}


const FOLDER_MAX_ENTRIES = 200
const FOLDER_TREE_BUDGET = 4_000

function normSlash(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}


export async function loadFolderAttachment(
  absPath: string,
  workspaceRoot: string
): Promise<ContextAttachment | null> {
  let all: string[]
  try {
    all = await window.lc.listFiles(workspaceRoot)
  } catch {
    toast.error('无法读取目录')
    return null
  }
  const folder = normSlash(absPath)
  const under = all
    .map(normSlash)
    .filter((f) => f === folder || f.startsWith(folder + '/'))
    .map((f) => f.slice(folder.length + 1))
    .filter(Boolean)
    .sort()

  if (under.length === 0) {
    toast.warn('该文件夹为空或无可用文件')
    return null
  }

  const shown = under.slice(0, FOLDER_MAX_ENTRIES)
  const relFolder = normSlash(workspaceRoot) && folder.startsWith(normSlash(workspaceRoot))
    ? folder.slice(normSlash(workspaceRoot).length + 1) || '.'
    : folder
  let body = `Directory: ${relFolder} (${under.length} files)\n` + shown.map((r) => `  ${r}`).join('\n')
  if (under.length > shown.length) body += `\n  … and ${under.length - shown.length} more`
  if (body.length > FOLDER_TREE_BUDGET) {
    body = body.slice(0, FOLDER_TREE_BUDGET) + '\n  …(truncated)'
  }

  return { kind: 'folder', path: absPath, content: body }
}


export function buildRuleAttachment(name: string, body?: string): ContextAttachment | null {
  const text = (body ?? '').trim()
  if (!text) {
    toast.warn('该规则没有正文内容')
    return null
  }
  return { kind: 'rule', path: name, content: text }
}
