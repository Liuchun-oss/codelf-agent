import { useMemo, useState } from 'react'
import type { Room } from '@shared/roomTypes'
import RoomSelect from './RoomSelect'

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
  const mentionOptions = useMemo(
    () => [
      { value: '', label: '@主管（默认）' },
      ...room.seats.filter((s) => !s.isHost && s.enabled).map((s) => ({ value: s.id, label: `@${s.name}` }))
    ],
    [room.seats]
  )

  const submit = (): void => {
    const t = text.trim()
    if (!t) return
    onSend(t, mention || undefined)
    setText('')
  }

  return (
    <div className="room-composer">
      <div className="room-composer-row">
        <RoomSelect
          className="room-mention-select"
          value={mention}
          options={mentionOptions}
          onChange={setMention}
        />
        {busy && <span className="room-composer-busy">团队进行中…（可随时找主管说话）</span>}
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
        {/* 发送按钮始终可用：团队在后台干活时，你仍能随时找群主说话/追问进度（并行协作核心）。
            中断按钮仅在 busy 时额外并排出现，而非替换发送按钮。 */}
        {busy && (
          <button type="button" className="room-stop-btn" onClick={onStop} title="中断当前所有发言">
            中断
          </button>
        )}
        <button type="button" className="room-send-btn" onClick={submit} disabled={!text.trim()}>
          发送
        </button>
      </div>
    </div>
  )
}
