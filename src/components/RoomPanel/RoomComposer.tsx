import { useState } from 'react'
import type { Room } from '@shared/roomTypes'

// 输入框：支持选择 @ 目标（不选默认发主管）。Enter 发送，Shift+Enter 换行。
export default function RoomComposer({
  room,
  busy,
  onSend,
  onStop
}: {
  room: Room
  busy: boolean
  onSend: (text: string, mention?: string) => void
  onStop: () => void
}): JSX.Element {
  const [text, setText] = useState('')
  const [mention, setMention] = useState<string>('')

  const submit = (): void => {
    const t = text.trim()
    if (!t) return
    onSend(t, mention || undefined)
    setText('')
  }

  return (
    <div className="room-composer">
      <div className="room-composer-row">
        <select
          className="room-mention-select"
          value={mention}
          onChange={(e) => setMention(e.target.value)}
          title="选择 @ 的对象"
        >
          <option value="">@主管（默认）</option>
          {room.seats.filter((s) => !s.isHost && s.enabled).map((s) => (
            <option key={s.id} value={s.id}>@{s.name}</option>
          ))}
        </select>
        {busy && <span className="room-composer-busy">团队进行中…</span>}
      </div>
      <div className="room-composer-input">
        <textarea
          value={text}
          placeholder="输入消息，Enter 发送，Shift+Enter 换行"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          rows={2}
        />
        {busy ? (
          <button type="button" className="room-stop-btn" onClick={onStop} title="中断当前发言">
            中断
          </button>
        ) : (
          <button type="button" className="room-send-btn" onClick={submit} disabled={!text.trim()}>
            发送
          </button>
        )}
      </div>
    </div>
  )
}
