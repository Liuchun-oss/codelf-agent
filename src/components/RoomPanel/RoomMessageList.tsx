import { useEffect, useRef } from 'react'
import SeatBubble from './SeatBubble'
import type { RoomMessageView } from '../../stores/roomStore'

// 群消息流：每条发言一个气泡。仅当用户已贴近底部时才自动跟随，避免上翻看历史时被强拉到底（B2-3）。
export default function RoomMessageList({ messages }: { messages: RoomMessageView[] }): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  // 依赖稳定的派生量（条数 + 最后一条文本长度），而非整个 messages 引用，减少无谓 effect。
  const last = messages[messages.length - 1]
  const followKey = `${messages.length}:${last?.id ?? ''}:${last?.text.length ?? 0}`

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    if (nearBottom) endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [followKey])

  if (messages.length === 0) {
    return <div className="room-messages room-messages--empty">直接说一句话（如「做个登录页」），主管会理解需求并分派给团队。无需 @，默认发给主管；想单独找某个岗位，可在右侧成员点「私聊」。</div>
  }
  return (
    <div className="room-messages" ref={containerRef}>
      {messages.map((m) => <SeatBubble key={m.id} msg={m} />)}
      <div ref={endRef} />
    </div>
  )
}
