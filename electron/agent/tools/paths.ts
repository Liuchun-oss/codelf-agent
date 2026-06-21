import { resolve, isAbsolute } from 'path'


export function resolveAnyPath(workspaceRoot: string | null, p: string): string {
  if (!p.trim()) throw new Error('路径不能为空')
  if (isAbsolute(p)) return resolve(p)
  if (!workspaceRoot) throw new Error('当前对话未设置工作目录，无法解析相对路径，请使用绝对路径或为对话选择目录')
  return resolve(workspaceRoot, p)
}
