import { useState } from 'react'
import type { Room } from '@shared/roomTypes'
import type { ScheduleKind } from '@shared/scheduleTypes'
import { useDismiss } from './useDismiss'
import RoomSelect from './RoomSelect'

// 定时群会议弹窗（U3）：到点把议题投进群，由主管分派团队开工。
// 频率给几个预设 + 自定义 cron 高级项；投递方式 UI / 微信。
const PRESETS: Array<{ id: string; label: string; build: () => ScheduleKind }> = [
  { id: 'daily9', label: '每天 9:00', build: () => ({ kind: 'cron', expr: '0 9 * * *' }) },
  { id: 'mon9', label: '每周一 9:00', build: () => ({ kind: 'cron', expr: '0 9 * * 1' }) },
  { id: 'hourly', label: '每小时', build: () => ({ kind: 'every', everyMs: 3600_000 }) },
  { id: 'cron', label: '自定义 cron', build: () => ({ kind: 'cron', expr: '0 9 * * *' }) }
]

export default function RoomTaskDialog({ room, onClose }: { room: Room; onClose: () => void }): JSX.Element {
  const [topic, setTopic] = useState('')
  const [presetId, setPresetId] = useState('daily9')
  const [cronExpr, setCronExpr] = useState('0 9 * * *')
  const [delivery, setDelivery] = useState<'ui' | 'weixin'>('ui')
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState('')
  const [error, setError] = useState('')
  const { closing, requestClose, onAnimationEnd } = useDismiss(onClose)

  const isCron = presetId === 'cron'

  const submit = async (): Promise<void> => {
    if (!topic.trim()) { setError('请填写会议议题'); return }
    const preset = PRESETS.find((p) => p.id === presetId)!
    const schedule: ScheduleKind = isCron ? { kind: 'cron', expr: cronExpr.trim() } : preset.build()
    setSubmitting(true)
    setError('')
    try {
      const r = await window.lc.room.registerRoomTask(room.id, topic.trim(), schedule, delivery)
      if (r.ok) {
        setResult(`已设定时会议「${r.taskName}」。到点会自动把议题投进群让团队开工。`)
      } else {
        setError('设定失败。')
        setSubmitting(false)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setSubmitting(false)
    }
  }

  return (
    <div className={`room-dialog-overlay${closing ? ' closing' : ''}`} onClick={requestClose}>
      <div
        className="room-dialog room-dialog--narrow"
        onClick={(e) => e.stopPropagation()}
        onAnimationEnd={onAnimationEnd}
      >
        <div className="room-dialog-header">
          <span>定时群会议</span>
          <button type="button" className="room-dialog-close" onClick={requestClose}>×</button>
        </div>
        <div className="room-dialog-body">
          {result ? (
            <div className="room-task-done">{result}</div>
          ) : (
            <>
              <label className="room-field">
                <span className="room-field-label">会议议题</span>
                <textarea
                  value={topic}
                  rows={3}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder="如：过一遍今天的待办，每个岗位汇报进度和卡点"
                />
              </label>
              <label className="room-field">
                <span className="room-field-label">频率</span>
                <RoomSelect
                  value={presetId}
                  options={PRESETS.map((p) => ({ value: p.id, label: p.label }))}
                  onChange={setPresetId}
                />
              </label>
              {isCron && (
                <label className="room-field">
                  <span className="room-field-label">cron 表达式</span>
                  <input value={cronExpr} onChange={(e) => setCronExpr(e.target.value)} placeholder="0 9 * * *" />
                  <span className="room-field-hint">分 时 日 月 周。例：0 9 * * 1 = 每周一 9 点。</span>
                </label>
              )}
              <label className="room-field">
                <span className="room-field-label">结果投递</span>
                <RoomSelect
                  value={delivery}
                  options={[{ value: 'ui', label: '应用内' }, { value: 'weixin', label: '微信' }]}
                  onChange={(v) => setDelivery(v as 'ui' | 'weixin')}
                />
              </label>
              {error && <div className="room-dialog-error">{error}</div>}
            </>
          )}
        </div>
        <div className="room-dialog-footer">
          <button type="button" className="room-dialog-cancel" onClick={requestClose}>{result ? '完成' : '取消'}</button>
          {!result && (
            <button type="button" className="room-dialog-create" disabled={submitting} onClick={() => void submit()}>
              {submitting ? '设定中…' : '设为定时会议'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
