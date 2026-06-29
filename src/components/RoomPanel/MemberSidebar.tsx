import { useEffect, useRef, useState } from 'react'
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

// 成员侧栏：紧凑单行显示每个岗位（头像/名字/职责/状态），操作收进「⋯」下拉菜单（§7.2）。
export default function MemberSidebar({
  room,
  runtime,
  width
}: {
  room: Room
  runtime: Record<string, SeatRuntimeView>
  width?: number
}): JSX.Element {
  const { pauseSeat, resumeSeat, kickSeat, deleteRoom } = useRoomStore()
  const [chatSeatId, setChatSeatId] = useState<string | null>(null)
  const [editor, setEditor] = useState<{ seat?: Seat } | null>(null)
  const [menuSeatId, setMenuSeatId] = useState<string | null>(null)
  const listRef = useRef<HTMLUListElement>(null)

  // 点击菜单外部 / 按 Esc 关闭操作菜单。
  useEffect(() => {
    if (!menuSeatId) return
    const onDown = (e: MouseEvent): void => {
      if (!listRef.current?.contains(e.target as Node)) setMenuSeatId(null)
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setMenuSeatId(null) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [menuSeatId])

  const handleDisband = (): void => {
    const ok = confirm(
      `确定解散「${room.title}」吗？\n\n` +
      '这会永久删除该群的全部聊天记录、各岗位的记忆/错题本与 KPI 历史，无法恢复。'
    )
    if (!ok) return
    void deleteRoom(room.id)
  }
  return (
    <aside className="room-members" style={width ? { width } : undefined}>
      <div className="room-members-title">成员（{room.seats.filter((s) => s.enabled).length}）</div>
      {room.weixinBinding && (
        <div className="room-weixin-badge" title="已绑定微信：在微信里发『/room 任务』即可远程派活，岗位提问/审批会推到你微信。">
          微信遥控已开启
        </div>
      )}
      <ul className="room-members-list" ref={listRef}>
        {room.seats.filter((s) => s.enabled).map((s) => {
          const rt = runtime[s.id]
          const paused = rt?.paused
          const state = paused ? 'paused' : rt?.state ?? 'idle'
          const menuOpen = menuSeatId === s.id
          const closeMenu = (): void => setMenuSeatId(null)
          return (
            <li key={s.id} className={`room-member${menuOpen ? ' menu-open' : ''}`}>
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
                <button
                  type="button"
                  className="room-member-menu-btn"
                  title="操作"
                  aria-label="操作"
                  onClick={() => setMenuSeatId(menuOpen ? null : s.id)}
                >⋯</button>
              </div>
              <div className={`room-member-menu${menuOpen ? ' open' : ''}`}>
                <div className="room-member-menu-inner">
                  <button type="button" onClick={() => { closeMenu(); setChatSeatId(s.id) }}>私聊</button>
                  <button type="button" onClick={() => { closeMenu(); setEditor({ seat: s }) }}>编辑</button>
                  {!s.isHost && (paused
                    ? <button type="button" onClick={() => { closeMenu(); void resumeSeat(s.id) }}>恢复</button>
                    : <button type="button" onClick={() => { closeMenu(); void pauseSeat(s.id) }}>暂停</button>)}
                  {!s.isHost && (
                    <button
                      type="button"
                      className="danger"
                      onClick={() => { closeMenu(); if (confirm(`确定把「${s.name}」踢出群聊吗？（数据保留，可重建）`)) void kickSeat(s.id) }}
                    >踢出</button>
                  )}
                </div>
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
