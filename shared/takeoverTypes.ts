// 全屏自主接管模式（阶段 1：软接管）的共享类型，主进程与渲染层共用。
// 进入接管由 agent 工具 EnterDesktopTakeover 自主触发；本文件只描述 HUD 与状态。

export type TakeoverState = 'idle' | 'preparing' | 'running' | 'finishing' | 'restoring'

// 退出原因：用户按 ESC、点 HUD 停止、看门狗超时、任务完成、出错。
export type TakeoverStopReason = 'escape' | 'user' | 'watchdog' | 'completed' | 'error'

// 推送给 HUD 的状态快照。
export interface TakeoverStatus {
  state: TakeoverState
  task?: string
  reason?: TakeoverStopReason
  // 自接管开始累计的步骤数（工具调用次数）。
  steps?: number
  message?: string
}

// HUD 渲染层用到的精简 agent 事件（文本流 / 工具进度 / 状态）。
export interface TakeoverHudEvent {
  kind: 'text' | 'tool' | 'status' | 'error'
  text?: string
  status?: TakeoverStatus
}
