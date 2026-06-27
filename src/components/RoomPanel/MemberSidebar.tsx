import { useState } from 'react'
import type { Room, Seat } from '@shared/roomTypes'
import { useRoomStore, type SeatRuntimeView } from '../../stores/roomStore'
import SeatChatDrawer from './SeatChatDrawer'
import SeatEditorDialog from './SeatEditorDialog'

const STATE_LABEL: Record<string, string> = {
  idle: '空闲',
  working: '工作中',
  'waiting-user': '等你回复',
  paused: '已暂停',
  error: '出错',
  done: '完成'
}

// 成员侧栏：显示每个岗位的头像/名字/职责/状态 + 暂停/恢复/踢出操作（§7.2）。
export default function MemberSidebar({
  room,
  runtime
}: {
  room: Room
  runtime: Record<string, SeatRuntimeView>
}): JSX.Element {
  const { pauseSeat, resumeSeat, kickSeat, deleteRoom } = useRoomStore()
  const [chatSeatId, setChatSeatId] = useState<string | null>(null)
  const [editor, setEditor] = useState<{ seat?: Seat } | null>(null)
  const handleDisband = (): void => {
    const ok = confirm(
      `确定解散「${room.title}」吗？\n\n` +
      '这会永久删除该群的全部聊天记录、各岗位的记忆/错题本与 KPI 历史，无法恢复。'
    )
    if (!ok) return
    void deleteRoom(room.id)
  }
  return (
    <aside className="room-members">
      <div className="room-members-title">成员（{room.seats.filter((s) => s.enabled).length}）</div>
      {room.weixinBinding && (
        <div className="room-weixin-badge" title="已绑定微信：在微信里发『/room 任务』即可远程派活，岗位提问/审批会推到你微信。">
          微信遥控已开启
        </div>
      )}
      <ul className="room-members-list">
        {room.seats.filter((s) => s.enabled).map((s) => {
          const rt = runtime[s.id]
          const paused = rt?.paused
          const state = paused ? 'paused' : rt?.state ?? 'idle'
          return (
            <li key={s.id} className="room-member">
              <div className="room-member-top">
                <div className="room-member-avatar">{s.avatar ?? s.name.slice(0, 2)}</div>
                <div className="room-member-info">
                  <div className="room-member-name">
                    {s.name}
                    {s.isHost && <span className="room-member-host">群主</span>}
                  </div>
                  <div className="room-member-role">{s.role}</div>
                </div>
                <span className={`room-member-state room-member-state--${state}`}>{STATE_LABEL[state] ?? state}</span>
              </div>
              <div className="room-member-actions">
                <button type="button" title="单独私聊该岗位" onClick={() => setChatSeatId(s.id)}>私聊</button>
                <button type="button" title="编辑岗位" onClick={() => setEditor({ seat: s })}>编辑</button>
                {!s.isHost && (paused
                  ? <button type="button" title="恢复" onClick={() => void resumeSeat(s.id)}>恢复</button>
                  : <button type="button" title="暂停" onClick={() => void pauseSeat(s.id)}>暂停</button>)}
                {!s.isHost && (
                  <button
                    type="button"
                    title="踢出"
                    onClick={() => { if (confirm(`确定把「${s.name}」踢出群聊吗？（数据保留，可重建）`)) void kickSeat(s.id) }}
                  >踢出</button>
                )}
              </div>
            </li>
          )
        })}
      </ul>
      <button type="button" className="room-add-seat-btn" onClick={() => setEditor({})}>＋ 添加岗位</button>
      <button type="button" className="room-disband-btn" onClick={handleDisband} title="永久删除该群及其全部数据">
        解散群聊
      </button>
      {chatSeatId && (
        <SeatChatDrawer room={room} seatId={chatSeatId} onClose={() => setChatSeatId(null)} />
      )}
      {editor && (
        <SeatEditorDialog seat={editor.seat} onClose={() => setEditor(null)} />
      )}
    </aside>
  )
}
