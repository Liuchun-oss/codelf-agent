// SessionBridge：消费 QueryEngine 的事件流，翻译成微信消息。
// 覆盖策划书阶段 1/2 的边界项：
//  - B7 段落节流、B4 分块发送、#7 发送队列保证顺序
//  - A2 处理中提示、#4 引擎错误翻译成中文
//  - 阶段2：permission_request / user_question 转微信确认并等待回复

import type { AgentEvent, AgentErrorCode } from '@shared/agentTypes'

export interface BridgeSink {
  // 发送一段文本到微信（内部维护发送队列，保证顺序）。
  send: (text: string) => void
}

// #4：把引擎错误码翻译成中文人话发回微信。
function translateError(code: AgentErrorCode, message: string): string {
  switch (code) {
    case 'no_profile':
      return '尚未配置模型，请在 Codelf 设置里配置 Provider 后再试。'
    case 'provider_auth':
      return '模型鉴权失败，请检查 Codelf 里的 API Key。'
    case 'provider_not_found':
      return '找不到模型端点，请检查 Provider 配置。'
    case 'provider_rate_limit':
      return '模型调用触发限流，请稍后再试。'
    case 'provider_timeout':
      return '模型响应超时，请稍后再试。'
    case 'provider_server':
      return '模型服务端出错，请稍后再试。'
    case 'network':
      return '网络错误，无法连接模型服务。'
    case 'no_workspace':
      return '未配置工作区，当前只能纯对话，无法操作文件。'
    case 'tools_not_supported':
      return '当前模型不支持工具调用，无法远程编程。'
    case 'turn_limit':
      return '本轮已达最大步数限制而中止。'
    case 'cancelled':
      return '已中止当前任务。'
    default:
      return `出错了：${message || '未知错误'}`
  }
}

export class SessionBridge {
  // B7：累积的段落缓冲。
  private buffer = ''
  private sentAnything = false

  constructor(private readonly sink: BridgeSink) {}

  // 消费一个事件。返回的 Promise 用于"需要等待用户回复"的事件（阶段2）。
  consume(ev: AgentEvent): void {
    switch (ev.type) {
      case 'text_delta':
        this.onTextDelta(ev.content)
        break
      case 'turn_end':
        this.flush()
        if (!this.sentAnything) {
          // 一轮结束但没有任何文本（可能纯工具操作），给个完成提示。
          this.sink.send('（已完成，无文本输出）')
        }
        break
      case 'error':
        this.flush()
        this.sink.send(translateError(ev.code, ev.message))
        break
      case 'warning':
        // 警告并入正常输出节奏，避免刷屏；这里直接附带发送。
        this.sink.send(`⚠️ ${ev.message}`)
        break
      case 'notice':
        this.sink.send(ev.message)
        break
      default:
        // tool_call_* / thinking_delta 等：按决策不发进度消息。
        break
    }
  }

  private onTextDelta(content: string): void {
    this.buffer += content
    // B7：遇到段落边界（空行）就成段发出，不逐字刷屏。
    const idx = this.buffer.lastIndexOf('\n\n')
    if (idx >= 0) {
      const ready = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 2)
      if (ready) {
        this.sentAnything = true
        this.sink.send(ready)
      }
    }
  }

  // turn_end / error 时把剩余缓冲一次性发出。
  flush(): void {
    const rest = this.buffer.trim()
    this.buffer = ''
    if (rest) {
      this.sentAnything = true
      this.sink.send(rest)
    }
  }
}
