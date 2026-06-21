
const INVALID_CHARS = /[<>:"/\\|?*\u0000-\u001f]/
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i


export function validateName(raw: string): string | null {
  const name = raw.trim()
  if (!name) return '名称不能为空'
  if (name === '.' || name === '..') return '名称无效'
  if (INVALID_CHARS.test(name)) return '名称不能包含 < > : " / \\ | ? * 等字符'
  if (RESERVED.test(name.split('.')[0] ?? '')) return `"${name}" 为系统保留名`
  if (name.endsWith('.') || name.endsWith(' ')) return '名称不能以点(.)或空格结尾'
  if (name.length > 255) return '名称过长'
  return null
}
