import { useCallback, useEffect, useState } from 'react'
import type { Room, SeatKpiRecord } from '@shared/roomTypes'
import { useDismiss } from './useDismiss'

// 团队战报仪表盘（§12.7）：每个岗位 KPI 卡片 + 四维 + 评语 + 人工校准。
// 「出战报」按钮触发主管考核回合（§12.6），刷新各岗位最新 KPI。
export default function KpiDashboard({ room, onClose }: { room: Room; onClose: () => void }): JSX.Element {
  const [latest, setLatest] = useState<SeatKpiRecord[]>([])
  const [report, setReport] = useState('')
  const [running, setRunning] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    const rows = await window.lc.room.kpiLatest(room.id).catch(() => [])
    setLatest(rows)
  }, [room.id])

  useEffect(() => { void refresh() }, [refresh])

  const runReview = async (): Promise<void> => {
    if (!confirm('将调用主管模型对全体岗位打分结算，会消耗一些 token。确定现在出战报吗？')) return
    setRunning(true)
    try {
      const rep = await window.lc.room.reviewCycle(room.id)
      setReport(rep)
      await refresh()
    } finally {
      setRunning(false)
    }
  }

  const registerWeekly = async (): Promise<void> => {
    const r = await window.lc.room.registerWeekly(room.id)
    setReport(r.ok ? `已注册定时任务「${r.taskName}」：每周一上午 9 点自动结算并在群里发战报。` : '注册失败。')
  }

  const byId = new Map(latest.map((r) => [r.seatId, r]))

  return (
    <div className="kpi-dashboard">
      <div className="kpi-dashboard-head">
        <span className="kpi-dashboard-title">团队战报</span>
        <div className="kpi-dashboard-actions">
          <button type="button" className="kpi-review-btn" disabled={running} onClick={() => void runReview()}>
            {running ? '考核中…' : '出战报（主管结算）'}
          </button>
          <button type="button" className="kpi-close-btn" onClick={() => void registerWeekly()}>设为每周自动</button>
          <button type="button" className="kpi-close-btn" onClick={onClose}>关闭</button>
        </div>
      </div>

      {report && <pre className="kpi-report">{report}</pre>}

      <div className="kpi-cards">
        {room.seats.filter((s) => s.enabled).map((seat) => {
          const rec = byId.get(seat.id)
          return (
            <KpiCard
              key={seat.id}
              roomId={room.id}
              seatId={seat.id}
              seatName={seat.name}
              role={seat.role}
              rec={rec}
              onCalibrated={() => void refresh()}
            />
          )
        })}
      </div>
    </div>
  )
}

function KpiCard({
  roomId,
  seatId,
  seatName,
  role,
  rec,
  onCalibrated
}: {
  roomId: string
  seatId: string
  seatName: string
  role: string
  rec?: SeatKpiRecord
  onCalibrated: () => void
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [kpi, setKpi] = useState(rec?.kpi ?? 70)
  const [comment, setComment] = useState(rec?.comment ?? '')
  const [memoryOpen, setMemoryOpen] = useState(false)

  const save = async (): Promise<void> => {
    await window.lc.room.kpiCalibrate(roomId, seatId, { kpi, comment })
    setEditing(false)
    onCalibrated()
  }

  const score = rec?.kpi ?? null
  const tone = score === null ? 'none' : score >= 85 ? 'high' : score >= 65 ? 'mid' : 'low'

  return (
    <div className="kpi-card">
      <div className="kpi-card-head">
        <div>
          <div className="kpi-card-name">{seatName}</div>
          <div className="kpi-card-role">{role}</div>
        </div>
        <div className={`kpi-score kpi-score--${tone}`}>{score ?? '—'}</div>
      </div>

      {rec ? (
        <>
          <div className="kpi-dims">
            {Object.entries(rec.dimensions).map(([k, v]) => (
              <div key={k} className="kpi-dim">
                <span className="kpi-dim-label">{k}</span>
                <span className="kpi-dim-bar"><span className="kpi-dim-fill" style={{ width: `${Math.max(0, Math.min(100, v))}%` }} /></span>
                <span className="kpi-dim-val">{v}</span>
              </div>
            ))}
          </div>
          {rec.highlights.length > 0 && <div className="kpi-line kpi-line--up">长板：{rec.highlights.join('；')}</div>}
          {rec.improvements.length > 0 && <div className="kpi-line kpi-line--down">短板：{rec.improvements.join('；')}</div>}
          {rec.comment && <div className="kpi-comment">{rec.comment}</div>}
          <div className="kpi-period">周期 {rec.period}</div>
        </>
      ) : (
        <div className="kpi-empty">尚无考核记录</div>
      )}

      {editing ? (
        <div className="kpi-edit">
          <label>分数 <input type="number" min={0} max={100} value={kpi} onChange={(e) => setKpi(Number(e.target.value))} /></label>
          <textarea value={comment} placeholder="主管评语…" onChange={(e) => setComment(e.target.value)} />
          <div className="kpi-edit-actions">
            <button type="button" onClick={() => void save()}>保存</button>
            <button type="button" onClick={() => setEditing(false)}>取消</button>
          </div>
        </div>
      ) : (
        <div className="kpi-card-actions">
          <button type="button" className="kpi-calibrate-btn" onClick={() => { setKpi(rec?.kpi ?? 70); setComment(rec?.comment ?? ''); setEditing(true) }}>
            人工校准
          </button>
          <button type="button" className="kpi-calibrate-btn" onClick={() => setMemoryOpen(true)}>
            错题本
          </button>
        </div>
      )}

      {memoryOpen && (
        <SeatMemoryDrawer roomId={roomId} seatId={seatId} seatName={seatName} onClose={() => setMemoryOpen(false)} />
      )}
    </div>
  )
}

// 团队战报右侧抽屉外壳：负责遮罩 + 滑入/滑出动画（先播退场再卸载）。
export function KpiDrawer({ room, onClose }: { room: Room; onClose: () => void }): JSX.Element {
  const { closing, requestClose, onAnimationEnd } = useDismiss(onClose)
  return (
    <div className={`room-kpi-drawer-mask${closing ? ' closing' : ''}`} onClick={requestClose}>
      <div className="room-kpi-drawer" onClick={(e) => e.stopPropagation()} onAnimationEnd={onAnimationEnd}>
        <KpiDashboard room={room} onClose={requestClose} />
      </div>
    </div>
  )
}

// 错题本/经验本查看与编辑抽屉（§13.7 / B5-2）：读岗位 MEMORY.md 全文，可手动改/删后保存。
function SeatMemoryDrawer({
  roomId,
  seatId,
  seatName,
  onClose
}: {
  roomId: string
  seatId: string
  seatName: string
  onClose: () => void
}): JSX.Element {
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('')
  const { closing, requestClose, onAnimationEnd } = useDismiss(onClose)

  useEffect(() => {
    let alive = true
    void window.lc.room.seatMemory(roomId, seatId)
      .then((m) => { if (alive) { setText(m); setLoading(false) } })
      .catch(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [roomId, seatId])

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const ok = await window.lc.room.seatMemorySave(roomId, seatId, text)
      setStatus(ok ? '已保存' : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={`seat-memory-drawer-mask${closing ? ' closing' : ''}`} onClick={requestClose}>
      <div className="seat-memory-drawer" onClick={(e) => e.stopPropagation()} onAnimationEnd={onAnimationEnd}>
        <div className="seat-memory-head">
          <span>{seatName} · 错题本 / 经验本</span>
          <button type="button" onClick={requestClose}>关闭</button>
        </div>
        {loading ? (
          <div className="seat-memory-loading">加载中…</div>
        ) : (
          <>
            <textarea
              className="seat-memory-text"
              value={text}
              placeholder="该岗位还没有记忆记录。"
              onChange={(e) => { setText(e.target.value); setStatus('') }}
            />
            <div className="seat-memory-actions">
              <span className="seat-memory-status">{status}</span>
              <button type="button" disabled={saving} onClick={() => void save()}>{saving ? '保存中…' : '保存'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
