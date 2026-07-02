import { useEffect, useRef } from 'react'
import type { Room } from '@shared/roomTypes'
import SeatBubble from './SeatBubble'
import type { RoomMessageView } from '../../stores/roomStore'

// 群消息流：每条发言一个气泡。仅当用户已贴近底部时才自动跟随，避免上翻看历史时被强拉到底（B2-3）。
// 两种视图（§U1）：
//  - '公屏'（public，默认）：只显示公开消息，私聊/私信不在此处（各自进私聊框）。
//  - '全部'（all）：上帝视角，按时间线显示全部消息（含私聊/私信/队友私语），每条私密消息标注可见范围。
export default function RoomMessageList({
  messages,
  roomId,
  room,
  mode = 'public'
}: {
  messages: RoomMessageView[]
  roomId?: string
  room?: Room | null
  mode?: 'public' | 'all'
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const didInitialScroll = useRef(false)
  // 公屏只显示公开消息；全部视图显示所有消息（私密的额外加可见范围标注）。
  const shown = mode === 'all' ? messages : messages.filter((m) => !(m.visibility && m.visibility.length))
  // 依赖稳定的派生量（条数 + 最后一条文本长度），而非整个 messages 引用，减少无谓 effect。
  const last = shown[shown.length - 1]
  const followKey = `${shown.length}:${last?.id ?? ''}:${last?.text.length ?? 0}`

  // 切群 / 切视图时重置「已初始滚动」标记，让新视图也会落到底部。
  useEffect(() => {
    didInitialScroll.current = false
  }, [roomId, mode])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    // 首次有内容时直接跳到底（无动画），解决进群/切群停在第一条的问题。
    if (!didInitialScroll.current && shown.length > 0) {
      didInitialScroll.current = true
      endRef.current?.scrollIntoView({ block: 'end' })
      return
    }
    // 之后仅当用户已贴近底部时才平滑跟随，避免上翻看历史被强拉到底。
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    if (nearBottom) endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [followKey, shown.length])

  if (shown.length === 0) {
    return <div className="room-messages room-messages--empty">直接说一句话（如「做个登录页」），主管会理解需求并分派给团队。无需 @，默认发给主管；想单独找某个岗位，可在右侧成员点「私聊」。</div>
  }
  return (
    <div className="room-messages" ref={containerRef}>
      {shown.map((m) =>
        mode === 'all'
          ? <SeatBubble key={m.id} msg={m} visibilityLabel={visibilityLabelOf(m, room)} />
          : <SeatBubble key={m.id} msg={m} />
      )}
      <div ref={endRef} />
    </div>
  )
}

// 把一条私密消息的可见范围渲染成人话标注（仅「全部」视图用）。公开消息返回 undefined。
function visibilityLabelOf(m: RoomMessageView, room?: Room | null): string | undefined {
  const vis = m.visibility
  if (!vis || vis.length === 0) return undefined
  const nameOf = (id: string): string => {
    if (id === 'user') return '你'
    if (id === 'system') return '系统'
    return room?.seats.find((s) => s.id === id)?.name ?? id
  }
  // 可见者 = 发送方 + 白名单；用户发起的私聊白名单里没有 user，补上「你」。
  const ids = new Set<string>([m.from, ...vis])
  if (m.from === 'user') ids.add('user')
  const names = [...ids].map(nameOf)
  return `🔒 仅 ${names.join('、')} 可见`
}
