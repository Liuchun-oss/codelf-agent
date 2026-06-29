import { useEffect, useRef, useState } from 'react'
import { useUiStore } from '../../stores/uiStore'
import { useRoomStore, type InteractivePrompt } from '../../stores/roomStore'
import type { Room } from '@shared/roomTypes'
import MemberSidebar from './MemberSidebar'
import RoomMessageList from './RoomMessageList'
import RoomComposer from './RoomComposer'
import CreateRoomDialog from './CreateRoomDialog'
import { KpiDrawer } from './KpiDashboard'
import RoomTaskDialog from './RoomTaskDialog'

// 群聊主面板（仿微信/飞书三栏：会话列表 | 群消息流 | 成员侧栏）。
// 首版单群：左侧列出已有群，中间消息流，右侧成员。
export default function RoomPanel(): JSX.Element {
  const { rooms, currentRoomId, messages, seatRuntime, roomRunning, pending, load, selectRoom } = useRoomStore()
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [showKpi, setShowKpi] = useState(false)
  const [showTask, setShowTask] = useState(false)
  const [showMembers, setShowMembers] = useState(false)
  // 成员栏宽度（可左右拖拽调整，持久化到 localStorage）。
  const [memberWidth, setMemberWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem('room.memberWidth'))
    return Number.isFinite(saved) && saved >= 200 && saved <= 560 ? saved : 240
  })
  const memberWidthRef = useRef(memberWidth)

  const startResizeMembers = (e: React.MouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = memberWidth
    document.body.classList.add('resizing-x')
    const onMove = (ev: MouseEvent): void => {
      // 手柄在成员栏左缘：向左拖（clientX 变小）变宽。
      const next = Math.min(560, Math.max(200, startW + (startX - ev.clientX)))
      memberWidthRef.current = next
      setMemberWidth(next)
    }
    const onUp = (): void => {
      document.body.classList.remove('resizing-x')
      localStorage.setItem('room.memberWidth', String(Math.round(memberWidthRef.current)))
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  useEffect(() => {
    void (async () => {
      await load()
      setLoading(false)
    })()
  }, [load])

  // 默认选中第一个群。
  useEffect(() => {
    if (!currentRoomId && rooms.length > 0) void selectRoom(rooms[0].id)
  }, [rooms, currentRoomId, selectRoom])

  const room = rooms.find((r) => r.id === currentRoomId) ?? null
  const msgs = currentRoomId ? messages[currentRoomId] ?? [] : []
  const runtime = currentRoomId ? seatRuntime[currentRoomId] ?? {} : {}
  const pend = currentRoomId ? pending[currentRoomId] ?? [] : []
  // U6：优先用后端广播的群级运行态（整轮连锁稳定 true），无广播时回退到 seat 态聚合。
  const explicitRunning = currentRoomId ? roomRunning[currentRoomId] : undefined
  const busy = explicitRunning ?? Object.values(runtime).some((r) => r.state === 'working' || r.state === 'waiting-user')

  return (
    <div className="room-panel">
      <header className="room-panel-titlebar">
        <button type="button" className="room-back-btn" onClick={() => useUiStore.getState().setAppView('home')} title="返回首页">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M15 18l-6-6 6-6" />
          </svg>
          <span>返回</span>
        </button>
        <span className="room-panel-title-divider" aria-hidden />
        <span className="room-panel-title">{room ? room.title : '群聊'}</span>
        {room && (
          <div className="room-titlebar-actions">
            <button type="button" className="room-kpi-btn room-members-toggle" onClick={() => setShowMembers((v) => !v)} title="成员">
              成员
            </button>
            <button type="button" className="room-kpi-btn" onClick={() => setShowTask(true)} title="定时群会议">
              定时会议
            </button>
            <button type="button" className="room-kpi-btn" onClick={() => setShowKpi(true)} title="团队战报">
              团队战报
            </button>
          </div>
        )}
      </header>

      <div className={`room-panel-body${showMembers ? ' members-open' : ''}`}>
        <nav className="room-list">
          <div className="room-list-title">
            群聊
            <button type="button" className="room-list-new" onClick={() => setCreating(true)} title="新建群聊">＋</button>
          </div>
          {loading && <div className="room-list-empty">加载中…</div>}
          {!loading && rooms.length === 0 && <div className="room-list-empty">还没有群聊</div>}
          {rooms.map((r) => (
            <button
              key={r.id}
              type="button"
              className={`room-list-item${r.id === currentRoomId ? ' active' : ''}`}
              onClick={() => void selectRoom(r.id)}
            >
              <span className="room-list-name">{r.title}</span>
              <span className="room-list-count">{r.seats.length} 人</span>
            </button>
          ))}
        </nav>

        {room ? (
          <>
            <main className="room-main">
              <PendingBanner prompts={pend} room={room} />
              <RoomMessageList messages={msgs} roomId={currentRoomId ?? undefined} />
              <RoomComposer
                room={room}
                busy={busy}
                onSend={(text, mention) => void useRoomStore.getState().send(text, mention)}
                onStop={() => void useRoomStore.getState().stop()}
              />
            </main>
            <div
              className="room-members-resizer"
              onMouseDown={startResizeMembers}
              title="拖动调整成员栏宽度"
            />
            <MemberSidebar room={room} runtime={runtime} width={memberWidth} />
            {showMembers && <div className="room-members-scrim" onClick={() => setShowMembers(false)} />}
            {showKpi && (
              <KpiDrawer room={room} onClose={() => setShowKpi(false)} />
            )}
            {showTask && <RoomTaskDialog room={room} onClose={() => setShowTask(false)} />}
          </>
        ) : (
          <main className="room-main room-main--empty">
            {loading ? '加载中…' : (
              <div className="room-empty-cta">
                <p>还没有群聊。创建一个，拉几个岗位进来开工。</p>
                <button type="button" className="room-dialog-create" onClick={() => setCreating(true)}>+ 新建群聊</button>
              </div>
            )}
          </main>
        )}
      </div>
      {creating && <CreateRoomDialog onClose={() => setCreating(false)} />}
    </div>
  )
}

// 交互类事件横幅（§7.4 第二类）：提问/审批强制弹出、挂起全群，等用户回应。
// 竖向卡片布局：标题行（谁在等你）→ 正文 → 操作区（选项按钮换行 + 输入框独立成行）。
function PendingBanner({ prompts, room }: { prompts: InteractivePrompt[]; room: Room }): JSX.Element | null {
  if (prompts.length === 0) return null
  const p = prompts[0]
  const store = useRoomStore.getState()
  const more = prompts.length - 1
  const seat = room.seats.find((s) => s.id === p.seatId)
  const seatName = seat?.name ?? '某岗位'
  const isPermission = p.kind === 'permission'

  return (
    <div className={`room-banner${isPermission ? ' room-banner--permission' : ' room-banner--question'}`}>
      <div className="room-banner-head">
        <span className="room-banner-icon" aria-hidden>{isPermission ? '🔐' : '💬'}</span>
        <span className="room-banner-label">
          <strong>{seatName}</strong>
          {isPermission ? ' 请求授权' : ' 想问你'}
        </span>
        {more > 0 && <span className="room-banner-more">还有 {more} 条待回应</span>}
      </div>
      <div className="room-banner-text">{p.text}</div>
      {isPermission ? (
        <div className="room-banner-actions">
          <button type="button" className="room-banner-btn room-banner-btn--primary" onClick={() => void store.resolvePermission(p, true)}>同意</button>
          <button type="button" className="room-banner-btn room-banner-btn--ghost" onClick={() => void store.resolvePermission(p, false)}>拒绝</button>
        </div>
      ) : (
        <QuestionReply prompt={p} />
      )}
    </div>
  )
}

function QuestionReply({ prompt }: { prompt: InteractivePrompt }): JSX.Element {
  const [answer, setAnswer] = useState('')
  const store = useRoomStore.getState()
  const hasSuggestions = !!prompt.suggestions?.length
  return (
    <div className="room-banner-reply">
      {hasSuggestions && (
        <div className="room-banner-suggestions">
          {prompt.suggestions!.map((s) => (
            <button key={s} type="button" className="room-banner-chip" onClick={() => void store.resolveQuestion(prompt, s)}>{s}</button>
          ))}
        </div>
      )}
      <div className="room-banner-input-row">
        <input
          className="room-banner-input"
          value={answer}
          placeholder={hasSuggestions ? '或自己回复…' : '回复…'}
          onChange={(e) => setAnswer(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && answer.trim()) void store.resolveQuestion(prompt, answer.trim())
          }}
        />
        <button type="button" className="room-banner-btn room-banner-btn--primary" disabled={!answer.trim()} onClick={() => void store.resolveQuestion(prompt, answer.trim())}>回复</button>
      </div>
    </div>
  )
}
