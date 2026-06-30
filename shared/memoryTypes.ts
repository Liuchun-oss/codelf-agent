// 长期记忆系统的共享类型与默认值。
// 仅放纯数据/纯函数，主进程与渲染进程都可安全 import。

/** 记忆作用域。 */
export type MemoryScope = 'session' | 'project' | 'global'

export interface MemorySettings {
  /** 记忆系统总开关。关闭时不注入、不写入。 */
  enabled: boolean
  /** 新会话首轮在动态段注入项目/全局记忆摘要（不影响静态段缓存）。 */
  injectOnNewSession: boolean
  /** 每轮用本轮输入做语义召回，自动唤起相关情景记忆（HMS 主动联想召回）。 */
  autoRecall: boolean
  /** 注入摘要的 token 预算上限（超出按节预算裁剪）。 */
  injectBudgetTokens: number
  /** 压缩时派发 checkpoint-writer，将被丢弃的对话提取为结构化会话记忆。 */
  writerEnabled: boolean
  /** 任务完成后自动提醒 Agent 记笔记（复杂任务检测）。 */
  autoNoteReminder: boolean
}

export const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
  enabled: true,
  injectOnNewSession: true,
  autoRecall: true,
  injectBudgetTokens: 4000,
  writerEnabled: true,
  autoNoteReminder: true
}

export const MEMORY_SETTINGS_BOUNDS = {
  injectBudgetTokens: { min: 500, max: 32_000 }
} as const

export function normalizeMemorySettings(partial: Partial<MemorySettings> | undefined): MemorySettings {
  const p = partial ?? {}
  const b = MEMORY_SETTINGS_BOUNDS.injectBudgetTokens
  const budgetRaw =
    typeof p.injectBudgetTokens === 'number' && Number.isFinite(p.injectBudgetTokens)
      ? Math.floor(p.injectBudgetTokens)
      : DEFAULT_MEMORY_SETTINGS.injectBudgetTokens
  return {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : DEFAULT_MEMORY_SETTINGS.enabled,
    injectOnNewSession:
      typeof p.injectOnNewSession === 'boolean'
        ? p.injectOnNewSession
        : DEFAULT_MEMORY_SETTINGS.injectOnNewSession,
    autoRecall:
      typeof p.autoRecall === 'boolean' ? p.autoRecall : DEFAULT_MEMORY_SETTINGS.autoRecall,
    injectBudgetTokens: Math.min(b.max, Math.max(b.min, budgetRaw)),
    writerEnabled:
      typeof p.writerEnabled === 'boolean' ? p.writerEnabled : DEFAULT_MEMORY_SETTINGS.writerEnabled,
    autoNoteReminder:
      typeof p.autoNoteReminder === 'boolean' ? p.autoNoteReminder : DEFAULT_MEMORY_SETTINGS.autoNoteReminder
  }
}
