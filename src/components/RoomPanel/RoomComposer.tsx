import { useMemo, useRef, useState } from 'react'
import type { Room } from '@shared/roomTypes'
import RoomSelect from './RoomSelect'
import SlashPicker from '../AgentPanel/SlashPicker'
import SlashRefChips from '../AgentPanel/SlashRefChips'
import { useSlashRefs } from '../AgentPanel/useSlashRefs'

// 输入框：支持选择 @ 目标（不选默认发主管）。Enter 发送，Shift+Enter 换行。
// 支持 / 引用技能或插件，发送时把强制指令前置到消息。
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
  const [cursor, setCursor] = useState(0)
  const [mention, setMention] = useState<string>('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const slash = useSlashRefs(text, cursor, false)
  const syncCursor = (): void => {
    const el = textareaRef.current
    if (el) setCursor(el.selectionStart ?? 0)
  }
  const mentionOptions = useMemo(
    () => [
      { value: '', label: '@主管（默认）' },
      ...room.seats.filter((s) => !s.isHost && s.enabled).map((s) => ({ value: s.id, label: `@${s.name}` }))
    ],
    [room.seats]
  )

  const submit = (): void => {
    const t = text.trim()
    const message = slash.composeMessage(t)
    if (!message) return
    onSend(message, mention || undefined)
    setText('')
    setCursor(0)
    slash.clearSlashRefs()
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
      <SlashRefChips refs={slash.slashRefs} onRemove={slash.removeSlashRef} />
      <div className="room-composer-input">
        {slash.showSlashPicker && (
          <SlashPicker
            query={slash.slashQuery}
            activeIndex={slash.slashActive}
            onActiveIndexChange={slash.setSlashActive}
            onPick={(item) =>
              slash.applySlashPick(item, { input: text, setInput: setText, setCursor, textareaRef })
            }
            pickSignal={slash.slashPickSignal}
            onRowCountChange={slash.setSlashRowCount}
          />
        )}
        <textarea
          ref={textareaRef}
          value={text}
          placeholder="输入消息，/ 引用技能或插件，Enter 发送，Shift+Enter 换行"
          onChange={(e) => {
            setText(e.target.value)
            setCursor(e.target.selectionStart ?? e.target.value.length)
          }}
          onSelect={syncCursor}
          onClick={syncCursor}
          onKeyUp={syncCursor}
          onKeyDown={(e) => {
            if (slash.handleSlashKeyDown(e, { input: text, setInput: setText, setCursor })) return
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
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
        <button
          type="button"
          className="room-send-btn"
          onClick={submit}
          disabled={!text.trim() && slash.slashRefs.length === 0}
        >
          发送
        </button>
      </div>
    </div>
  )
}
