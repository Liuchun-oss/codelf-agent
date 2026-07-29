// §14.3 故障报警：错误码 → 人话 + 是否可重试。基于现有 AgentErrorCode。
import type { AgentErrorCode } from '@shared/agentTypes'

// 可自动重试的错误码（瞬断类）。其余视为「真卡死」需报警。
const RETRYABLE: ReadonlySet<AgentErrorCode> = new Set<AgentErrorCode>([
  'provider_rate_limit',
  'provider_timeout',
  'provider_server',
  'network'
])

export function isRetryableCode(code: AgentErrorCode): boolean {
  return RETRYABLE.has(code)
}

// 错误码翻译成给用户看的人话（§14.3 映射表）。seatName 用于「【小后】…」前缀。
export function explainError(code: AgentErrorCode, seatName: string, retrying: boolean): string {
  const tag = `【${seatName}】`
  switch (code) {
    case 'provider_rate_limit':
      return retrying ? `${tag}请求过于频繁，正在退避重试…` : `⚠️${tag}连续触发上游限流，已暂停。请稍后回复「继续」，或降低并发/切换模型。`
    case 'provider_timeout':
      return retrying ? `${tag}响应超时，重试中…` : `⚠️${tag}多次响应超时，已暂停，要继续吗？`
    case 'network':
      return retrying ? `${tag}网络中断，重试中…` : `⚠️${tag}网络持续不通，已暂停。`
    case 'provider_server':
      return retrying ? `${tag}服务端异常，重试中…` : `⚠️${tag}服务端持续异常，已暂停。`
    case 'provider_auth':
      return `⚠️${tag}卡住了：API 密钥失效，需你检查模型配置。`
    case 'turn_limit':
      return `⚠️${tag}达到回合上限，已暂停，要继续吗？`
    case 'denial_limit':
      return `⚠️${tag}达到拒绝上限，已暂停，要继续吗？`
    case 'no_profile':
    case 'provider_not_found':
      return `⚠️${tag}没有可用模型，请先配置。`
    case 'no_workspace':
      return `⚠️${tag}没有可用工作区，已暂停。`
    case 'tools_not_supported':
      return `⚠️${tag}当前模型不支持工具调用，已暂停。`
    case 'hook_blocked':
      return `⚠️${tag}请求被 hook 拦截，已暂停。`
    case 'cancelled':
      return `${tag}已被中止。`
    default:
      return `⚠️${tag}遇到未知错误，已暂停。`
  }
}
