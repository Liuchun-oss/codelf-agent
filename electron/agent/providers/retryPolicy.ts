// 统一的重试策略：把「这个错误要不要重试、等多久、最多几次」集中定义一处，
// 供 Provider 流内重连、QueryEngine 反应式压缩、IPC/子 Agent 外层重发共用，
// 避免退避时长与错误判定在多个文件各写各的（防止重复、口径不一致）。
import { ProviderError, isTransientNetworkError } from './base'
import type { AgentErrorCode } from '@shared/agentTypes'

// 统一的最大重试次数：各层「自动重试」都用这一个值，改一处即可全局生效。
export const MAX_AUTO_RETRIES = 5

// 是否可自动重试：瞬断类（网络/超时）+ 显式标注 retryable 的 ProviderError。
export function isRetryableError(e: unknown): boolean {
  return isTransientNetworkError(e)
}

// 是否为限流（429）：限流窗口较长，退避时长与普通瞬断不同。
export function isRateLimitCode(code: AgentErrorCode): boolean {
  return code === 'provider_rate_limit'
}

export function isRateLimitError(e: unknown): boolean {
  return e instanceof ProviderError && isRateLimitCode(e.code)
}

// 计算第 attempt 次重试前的退避毫秒数（attempt 从 1 开始）。
// 限流用更长的线性退避（10s/20s/…，封顶 60s）以跨过限流窗口；
// 其余瞬断用指数退避（2s/4s/…，封顶 30s）快速恢复。
export function retryDelayMs(attempt: number, rateLimited: boolean): number {
  return rateLimited
    ? Math.min(60000, 10000 * attempt)
    : Math.min(30000, 1000 * 2 ** attempt)
}
