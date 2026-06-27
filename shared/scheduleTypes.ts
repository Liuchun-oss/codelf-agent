// 定时任务（Scheduled Tasks）共享类型。主进程调度服务与渲染进程设置面板共用。
// 设计见 docs/定时任务功能策划书.md 第四章。

// 调度方式：三选一。
export type ScheduleKind =
  | { kind: 'at'; at: number } // 绝对时间戳(ms)，执行后默认删除
  | { kind: 'every'; everyMs: number } // 固定间隔重复
  | { kind: 'cron'; expr: string; tz?: string } // cron 表达式 + 时区

// 结果投递目标。
export type DeliveryMode = 'none' | 'weixin' | 'ui' | 'webhook'

export type ScheduleStatus = 'ok' | 'error' | 'running' | 'skipped'

export type DeliveryStatus = 'delivered' | 'failed' | 'skipped'

export interface ScheduledTask {
  id: string
  name: string
  description?: string
  enabled: boolean
  // at 任务默认 true；周期任务为 false。
  deleteAfterRun?: boolean
  schedule: ScheduleKind
  // 喂给 agent 的消息。
  prompt: string
  // 任务工作区根目录，null=纯对话（绝不回退编辑器工作区）。
  workspaceRoot?: string | null
  delivery: DeliveryMode
  // delivery==='webhook' 时的目标 URL（仅 http/https，POST JSON）。
  webhookUrl?: string
  // allowWrite=false → permissionMode:'default' + 自动拒绝所有写/命令交互（只读）。
  // allowWrite=true  → permissionMode:'acceptEdits' 自动放行（危险操作仍被引擎硬拦）。
  allowWrite: boolean
  // 开启后，下次触发会把「上次执行的输出」作为上下文塞进 prompt，实现轻量记忆
  // （不保留完整会话历史，故不会上下文膨胀）。适合增量类任务。默认关。
  carryLastOutput?: boolean
  createdAt: number
  updatedAt: number

  // 运行时状态。
  nextRunAt?: number
  lastRunAt?: number
  lastOutput?: string
  running?: boolean
  lastStatus?: ScheduleStatus
  lastError?: string
  lastDeliveryStatus?: DeliveryStatus
  consecutiveErrors?: number
}

// 创建任务入参：运行时字段由服务计算，不在草稿里。
export interface ScheduledTaskDraft {
  name: string
  description?: string
  enabled?: boolean
  schedule: ScheduleKind
  prompt: string
  workspaceRoot?: string | null
  delivery?: DeliveryMode
  webhookUrl?: string
  allowWrite?: boolean
  carryLastOutput?: boolean
  deleteAfterRun?: boolean
}

// 更新任务：可改的字段（运行时状态由服务维护，不开放给 UI 直接写）。
export type ScheduledTaskPatch = Partial<ScheduledTaskDraft>

// every 间隔下限：防止误配置高频空转。
export const MIN_EVERY_MS = 60 * 1000

// 单任务硬执行上限：到点强制熔断。
export const HARD_TIMEOUT_MS = 5 * 60 * 1000

// 连续失败达此阈值自动停用。
export const MAX_CONSECUTIVE_ERRORS = 3

// webhook 投递超时。
export const WEBHOOK_TIMEOUT_MS = 15 * 1000
