import { useEffect, useRef, useState } from 'react'
import type { Room } from '@shared/roomTypes'
import { useRoomStore } from '../../stores/roomStore'
import MarkdownView from '../AgentPanel/MarkdownView'
import SlashPicker from '../AgentPanel/SlashPicker'
import SlashRefChips from '../AgentPanel/SlashRefChips'
import ForcedRefsBadge from '../AgentPanel/ForcedRefsBadge'
import { useSlashRefs } from '../AgentPanel/useSlashRefs'
import { stripForcedInstruction } from '../AgentPanel/slashCommand'
import { useDismiss } from './useDismiss'

// 岗位 1v1 私聊抽屉（§7.2 / U1）：集中显示「与该岗位相关的全部私聊消息」——
// 用户私聊它、主管私信它、它的私密回复、以及它收到/发出的队友私语。
// 这些私密消息不在公屏显示（公屏只留公开发言），只在此处按「来自 XXX · 时间」呈现。
// 底部输入直接调 privateChat（只调度该岗位一回合，不触发全群连锁）。
function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

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
  const [cursor, setCursor] = useState(0)
  const bodyRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const slash = useSlashRefs(text, cursor, false)
  const syncCursor = (): void => {
    const el = textareaRef.current
    if (el) setCursor(el.selectionStart ?? 0)
  }
  const { closing, requestClose, onAnimationEnd } = useDismiss(onClose)

  const seat = room.seats.find((s) => s.id === seatId)
  const nameOf = (from: string): string => {
    if (from === 'user') return '我'
    if (from === 'system') return '系统'
    return room.seats.find((s) => s.id === from)?.name ?? from
  }
  // 私聊视图：只收「与该岗位相关的私密消息」。
  // - 带 visibility 且白名单含本岗位：主管私信它 / 队友私语它 / 它对队友的私语 / 它的私密回复。
  // - 用户对它的定向私聊（visibility 含本岗位，上面已覆盖；兜底再认 to===seatId）。
  // 公开消息（无 visibility）不进私聊框，留在公屏。
  const thread = messages.filter((m) => {
    const vis = m.visibility
    if (vis && vis.length) return vis.includes(seatId) || m.from === seatId
    return false
  })

  // 进入私聊 / 有新消息时滚到底。只滚动私聊框自身容器，不用 scrollIntoView
  // （后者会连带滚动祖先，与抽屉入场动画首帧冲突，造成卡顿）。
  const threadKey = `${thread.length}:${thread[thread.length - 1]?.id ?? ''}:${thread[thread.length - 1]?.text.length ?? 0}`
  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [threadKey, seatId])

  const submit = (): void => {
    const t = text.trim()
    const message = slash.composeMessage(t)
    if (!message) return
    void privateChat(seatId, message)
    setText('')
    setCursor(0)
    slash.clearSlashRefs()
  }

  return (
    <div
      className={`seat-chat-mask${closing ? ' closing' : ''}`}
      onClick={requestClose}
    >
      <div
        className={`seat-chat-drawer${closing ? ' closing' : ''}`}
        onClick={(e) => e.stopPropagation()}
        onAnimationEnd={onAnimationEnd}
      >
        <div className="seat-chat-head">
          <div className="seat-chat-title">
            <span className="seat-chat-name">私聊 · {seat?.name ?? seatId}</span>
            <span className="seat-chat-role">{seat?.role}</span>
          </div>
          <button type="button" onClick={requestClose}>关闭</button>
        </div>
        <div className="seat-chat-hint">这里只显示和该岗位相关的私聊（含主管私信、队友私语）。私聊只让 TA 单独回应一次，不会惊动全群。</div>
        <div className="seat-chat-body" ref={bodyRef}>
          {thread.length === 0
            ? <div className="seat-chat-empty">还没有私聊记录。在下方说一句，单独找 TA 聊。</div>
            : thread.map((m) => {
                const mine = m.from === 'user'
                const { body: pmText, forced: pmForced } = mine
                  ? stripForcedInstruction(m.text)
                  : { body: m.text, forced: [] }
                return (
                  <div key={m.id} className={`pm-item${mine ? ' pm-item--mine' : ''}`}>
                    <div className="pm-meta">
                      <span className="pm-from">来自 {nameOf(m.from)}</span>
                      <span className="pm-time">{formatTime(m.ts)}</span>
                    </div>
                    <div className="pm-bubble">
                      {pmText
                        ? <MarkdownView text={pmText} streaming={m.streaming} />
                        : m.streaming ? <span className="room-msg-typing">正在输入…</span> : null}
                      {pmForced.length > 0 && <ForcedRefsBadge refs={pmForced} />}
                    </div>
                  </div>
                )
              })}
        </div>
        <div className="seat-chat-composer">
          <SlashRefChips refs={slash.slashRefs} onRemove={slash.removeSlashRef} />
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
            placeholder={`单独对 ${seat?.name ?? '该岗位'} 说，/ 引用技能或插件，Enter 发送`}
            onChange={(e) => {
              setText(e.target.value)
              setCursor(e.target.selectionStart ?? e.target.value.length)
            }}
            onSelect={syncCursor}
            onClick={syncCursor}
            onKeyUp={syncCursor}
            onKeyDown={(e) => {
              if (slash.handleSlashKeyDown(e, { input: text, setInput: setText, setCursor })) return
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            rows={2}
          />
          <button type="button" className="room-send-btn" onClick={submit} disabled={!text.trim() && slash.slashRefs.length === 0}>发送</button>
        </div>
      </div>
    </div>
  )
}
