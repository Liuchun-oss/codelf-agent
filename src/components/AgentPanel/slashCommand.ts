// 斜线命令（/skill、/plugin）的检测与移除，逻辑对齐 atMention.ts。
// 触发条件：'/' 位于输入起始处，或紧跟在空白之后；query 中不含空白。

export interface SlashCommandRange {
  /** '/' 在原文中的下标 */
  slashIndex: number
  /** 检测时的光标位置 */
  cursor: number
  /** '/' 与光标之间的查询文本（不含 '/'） */
  query: string
}

const MAX_QUERY_LEN = 200

export function detectSlashCommand(text: string, cursor: number): SlashCommandRange | null {
  if (cursor < 0 || cursor > text.length) return null

  const before = text.slice(0, cursor)
  const slashIndex = before.lastIndexOf('/')
  if (slashIndex < 0) return null

  // 只有位于行首/词首（前一个字符是空白）才视为命令触发，避免路径中的 '/' 误触发。
  if (slashIndex > 0) {
    const prev = before[slashIndex - 1]
    if (prev !== ' ' && prev !== '\n' && prev !== '\r' && prev !== '\t') return null
  }

  const query = before.slice(slashIndex + 1)
  if (query.length > MAX_QUERY_LEN) return null
  if (/[\s\n\r\t]/.test(query)) return null

  return { slashIndex, cursor, query }
}

export function removeSlashCommand(
  text: string,
  range: SlashCommandRange
): { text: string; cursor: number } {
  const next = text.slice(0, range.slashIndex) + text.slice(range.cursor)
  return { text: next, cursor: range.slashIndex }
}

export type SlashRefKind = 'skill' | 'plugin'

/** 输入框中已选中的一条斜线引用（skill 或 plugin），发送时转成强制指令。 */
export interface SlashReference {
  kind: SlashRefKind
  /** skill 名 或 插件名 */
  name: string
  /** 插件携带的 skill 名 */
  pluginSkills?: string[]
  /** 插件携带的 MCP server 名 */
  pluginMcpServers?: string[]
}

/** 把已选引用拼成一段硬性约束文本，前置到用户消息。无引用返回空串。 */
export function buildForcedInstruction(refs: SlashReference[]): string {
  if (refs.length === 0) return ''
  const lines = refs.map((ref) => {
    if (ref.kind === 'skill') {
      return `- 你必须使用 skill「${ref.name}」（通过 Skill 工具加载并严格遵循其中的流程）。`
    }
    const parts: string[] = []
    if (ref.pluginSkills && ref.pluginSkills.length > 0) {
      parts.push(`skill ${ref.pluginSkills.map((s) => `「${s}」`).join('、')}`)
    }
    if (ref.pluginMcpServers && ref.pluginMcpServers.length > 0) {
      parts.push(`MCP 工具 ${ref.pluginMcpServers.map((s) => `「${s}」`).join('、')}`)
    }
    const what = parts.length > 0 ? parts.join(' 和 ') : `插件「${ref.name}」提供的能力`
    return `- 你必须使用插件「${ref.name}」所包含的 ${what} 来完成本次任务。`
  })
  const body = ['【强制要求】本次回复必须满足以下约束：', ...lines].join('\n')
  // 用隐藏标记包裹：模型能读到完整内容，但所有用户气泡渲染时会剥离这段，
  // 只显示用户输入的正文 + 一个小徽标，避免大段指令直接堆在气泡里。
  const meta = refs.map((r) => `${r.kind}:${r.name}`).join(',')
  return `${DIRECTIVE_OPEN}${meta}${DIRECTIVE_OPEN_END}\n${body}\n${DIRECTIVE_CLOSE}`
}

const DIRECTIVE_OPEN = '<codelf-directive refs="'
const DIRECTIVE_OPEN_END = '">'
const DIRECTIVE_CLOSE = '</codelf-directive>'
// 匹配整段隐藏指令（含其后紧跟的空白），用于从显示文本中剥离。
const DIRECTIVE_RE = /<codelf-directive\s+refs="([^"]*)">[\s\S]*?<\/codelf-directive>\s*/

export interface StrippedMessage {
  /** 剥离隐藏指令后、用于显示的正文 */
  body: string
  /** 被强制引用的项（用于显示小徽标），无则为空数组 */
  forced: SlashReference[]
}

/** 从消息文本中剥离隐藏的强制指令，返回可显示正文与被强制的引用列表。 */
export function stripForcedInstruction(text: string): StrippedMessage {
  const match = DIRECTIVE_RE.exec(text)
  if (!match) return { body: text, forced: [] }
  const forced: SlashReference[] = (match[1] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((token) => {
      const idx = token.indexOf(':')
      const kind = token.slice(0, idx) === 'plugin' ? 'plugin' : 'skill'
      return { kind, name: token.slice(idx + 1) } as SlashReference
    })
  const body = (text.slice(0, match.index) + text.slice(match.index + match[0].length)).trim()
  return { body, forced }
}

