import { useEffect, useState } from 'react'
import { useUiStore } from '../../stores/uiStore'
import { useRoomStore, type InteractivePrompt } from '../../stores/roomStore'
import MemberSidebar from './MemberSidebar'
import RoomMessageList from './RoomMessageList'
import RoomComposer from './RoomComposer'
import CreateRoomDialog from './CreateRoomDialog'
import KpiDashboard from './KpiDashboard'
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
              <PendingBanner prompts={pend} />
              <RoomMessageList messages={msgs} />
              <RoomComposer
                room={room}
                busy={busy}
                onSend={(text, mention) => void useRoomStore.getState().send(text, mention)}
                onStop={() => void useRoomStore.getState().stop()}
              />
            </main>
            <MemberSidebar room={room} runtime={runtime} />
            {showMembers && <div className="room-members-scrim" onClick={() => setShowMembers(false)} />}
            {showKpi && (
              <div className="room-kpi-drawer-mask" onClick={() => setShowKpi(false)}>
                <div className="room-kpi-drawer" onClick={(e) => e.stopPropagation()}>
                  <KpiDashboard room={room} onClose={() => setShowKpi(false)} />
                </div>
              </div>
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
function PendingBanner({ prompts }: { prompts: InteractivePrompt[] }): JSX.Element | null {
  if (prompts.length === 0) return null
  const p = prompts[0]
  const store = useRoomStore.getState()
  const more = prompts.length - 1
  return (
    <div className="room-banner">
      <div className="room-banner-text">
        ⚠️ <strong>有岗位需要你回应</strong>：{p.text}
        {more > 0 && <span className="room-banner-more">（还有 {more} 条待回应）</span>}
      </div>
      {p.kind === 'permission' ? (
        <div className="room-banner-actions">
          <button type="button" onClick={() => void store.resolvePermission(p, true)}>同意</button>
          <button type="button" onClick={() => void store.resolvePermission(p, false)}>拒绝</button>
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
  return (
    <div className="room-banner-actions">
      {prompt.suggestions?.map((s) => (
        <button key={s} type="button" onClick={() => void store.resolveQuestion(prompt, s)}>{s}</button>
      ))}
      <input
        value={answer}
        placeholder="回复…"
        onChange={(e) => setAnswer(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && answer.trim()) void store.resolveQuestion(prompt, answer.trim())
        }}
      />
      <button type="button" disabled={!answer.trim()} onClick={() => void store.resolveQuestion(prompt, answer.trim())}>回复</button>
    </div>
  )
}
