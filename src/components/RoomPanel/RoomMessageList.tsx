import { useEffect, useRef } from 'react'
import SeatBubble from './SeatBubble'
import type { RoomMessageView } from '../../stores/roomStore'

// 群消息流：每条发言一个气泡。仅当用户已贴近底部时才自动跟随，避免上翻看历史时被强拉到底（B2-3）。
// 公屏只显示公开消息：带 visibility 白名单的私聊消息不在这里显示，改在各岗位的私聊框里看。
export default function RoomMessageList({ messages, roomId }: { messages: RoomMessageView[]; roomId?: string }): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const didInitialScroll = useRef(false)
  const publicMessages = messages.filter((m) => !(m.visibility && m.visibility.length))
  // 依赖稳定的派生量（条数 + 最后一条文本长度），而非整个 messages 引用，减少无谓 effect。
  const last = publicMessages[publicMessages.length - 1]
  const followKey = `${publicMessages.length}:${last?.id ?? ''}:${last?.text.length ?? 0}`

  // 切群时重置「已初始滚动」标记，让新群也会落到底部。
  useEffect(() => {
    didInitialScroll.current = false
  }, [roomId])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    // 首次有内容时直接跳到底（无动画），解决进群/切群停在第一条的问题。
    if (!didInitialScroll.current && publicMessages.length > 0) {
      didInitialScroll.current = true
      endRef.current?.scrollIntoView({ block: 'end' })
      return
    }
    // 之后仅当用户已贴近底部时才平滑跟随，避免上翻看历史被强拉到底。
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    if (nearBottom) endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [followKey, publicMessages.length])

  if (publicMessages.length === 0) {
    return <div className="room-messages room-messages--empty">直接说一句话（如「做个登录页」），主管会理解需求并分派给团队。无需 @，默认发给主管；想单独找某个岗位，可在右侧成员点「私聊」。</div>
  }
  return (
    <div className="room-messages" ref={containerRef}>
      {publicMessages.map((m) => <SeatBubble key={m.id} msg={m} />)}
      <div ref={endRef} />
    </div>
  )
}
