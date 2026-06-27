import { useState } from 'react'
import type { Room } from '@shared/roomTypes'
import { useRoomStore } from '../../stores/roomStore'
import SeatBubble from './SeatBubble'

// 岗位 1v1 私聊抽屉（§7.2 / U1）：从群消息流里筛出「你↔该岗位」的往来，
// 底部输入直接调 privateChat（只调度该岗位一回合，不触发全群连锁）。
export default function SeatChatDrawer({
  room,
  seatId,
  onClose
}: {
  room: Room
  seatId: string
  onClose: () => void
}): JSX.Element {
  const messages = useRoomStore((s) => (room ? s.messages[room.id] ?? [] : []))
  const privateChat = useRoomStore((s) => s.privateChat)
  const [text, setText] = useState('')

  const seat = room.seats.find((s) => s.id === seatId)
  // 1v1 视图：该岗位的发言 + 你对它的定向消息。
  const thread = messages.filter((m) => m.from === seatId || (m.from === 'user' && m.to === seatId))

  const submit = (): void => {
    const t = text.trim()
    if (!t) return
    void privateChat(seatId, t)
    setText('')
  }

  return (
    <div className="seat-chat-mask" onClick={onClose}>
      <div className="seat-chat-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="seat-chat-head">
          <div className="seat-chat-title">
            <span className="seat-chat-name">私聊 · {seat?.name ?? seatId}</span>
            <span className="seat-chat-role">{seat?.role}</span>
          </div>
          <button type="button" onClick={onClose}>关闭</button>
        </div>
        <div className="seat-chat-hint">这里只显示你和该岗位的往来。私聊只让 TA 单独回应一次，不会惊动全群。</div>
        <div className="seat-chat-body">
          {thread.length === 0
            ? <div className="seat-chat-empty">还没有私聊记录。在下方说一句，单独找 TA 聊。</div>
            : thread.map((m) => <SeatBubble key={m.id} msg={m} />)}
        </div>
        <div className="seat-chat-composer">
          <textarea
            value={text}
            placeholder={`单独对 ${seat?.name ?? '该岗位'} 说，Enter 发送，Shift+Enter 换行`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            rows={2}
          />
          <button type="button" className="room-send-btn" onClick={submit} disabled={!text.trim()}>发送</button>
        </div>
      </div>
    </div>
  )
}
