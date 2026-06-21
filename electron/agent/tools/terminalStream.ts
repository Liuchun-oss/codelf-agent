import type { ToolContext } from './types'

const FLUSH_INTERVAL_MS = 100
const MAX_BUFFER_CHARS = 16_000

/**
 * 创建一个把终端增量输出节流推送到前端的 onData 回调。
 * 通过 tool_call_progress 事件的 chunk 字段传递增量，前端据此实时滚动。
 * 返回 { onData, flush }，工具结束时务必调用 flush() 推送残留缓冲。
 */
export function createTerminalStreamer(ctx: ToolContext): {
  onData: (chunk: string) => void
  flush: () => void
} {
  const canEmit = !!ctx.emitEvent && !!ctx.turnId && !!ctx.toolCallId
  if (!canEmit) {
    return { onData: () => {}, flush: () => {} }
  }

  let buffer = ''
  let timer: ReturnType<typeof setTimeout> | null = null

  const send = (): void => {
    timer = null
    if (!buffer) return
    const chunk = buffer.length > MAX_BUFFER_CHARS ? buffer.slice(-MAX_BUFFER_CHARS) : buffer
    buffer = ''
    ctx.emitEvent?.({
      type: 'tool_call_progress',
      turnId: ctx.turnId as string,
      callId: ctx.toolCallId as string,
      message: '',
      status: 'running',
      chunk
    })
  }

  const onData = (chunk: string): void => {
    buffer += chunk
    if (buffer.length >= MAX_BUFFER_CHARS) {
      if (timer) clearTimeout(timer)
      send()
      return
    }
    if (!timer) timer = setTimeout(send, FLUSH_INTERVAL_MS)
  }

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    send()
  }

  return { onData, flush }
}
