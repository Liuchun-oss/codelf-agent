import { useEffect, useState } from 'react'
import type { Seat, SeatDraft } from '@shared/roomTypes'
import type { ProviderProfileSummary } from '@shared/agentTypes'
import { useRoomStore } from '../../stores/roomStore'
import { useDismiss } from './useDismiss'
import RoomSelect from './RoomSelect'

// 岗位编辑器（U4）：建群后新增岗位 / 编辑已有岗位共用一个表单。
// mode='add' 调 addSeat；mode='edit' 调 editSeat（仅传改动字段，id 只读）。
export default function SeatEditorDialog({
  seat,
  onClose
}: {
  seat?: Seat
  onClose: () => void
}): JSX.Element {
  const addSeat = useRoomStore((s) => s.addSeat)
  const editSeat = useRoomStore((s) => s.editSeat)
  const isEdit = !!seat
  const [name, setName] = useState(seat?.name ?? '')
  const [role, setRole] = useState(seat?.role ?? '')
  const [persona, setPersona] = useState(seat?.personaPrompt ?? '')
  const [model, setModel] = useState(seat?.modelProfileId ?? '')
  const [readOnly, setReadOnly] = useState(!!seat?.readOnly)
  const [isolateWorktree, setIsolateWorktree] = useState(!!seat?.isolateWorktree)
  const [profiles, setProfiles] = useState<ProviderProfileSummary[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const { closing, requestClose, onAnimationEnd } = useDismiss(onClose)

  useEffect(() => {
    void window.lc.aiListProfiles().then(setProfiles).catch(() => setProfiles([]))
  }, [])

  const submit = async (): Promise<void> => {
    if (!name.trim() || !role.trim()) { setError('请填写名字和职责'); return }
    setSubmitting(true)
    setError('')
    try {
      if (isEdit && seat) {
        await editSeat(seat.id, {
          name: name.trim(),
          role: role.trim(),
          personaPrompt: persona.trim(),
          readOnly,
          isolateWorktree,
          modelProfileId: model || undefined
        })
      } else {
        const draft: SeatDraft = {
          name: name.trim(),
          role: role.trim(),
          personaPrompt: persona.trim(),
          readOnly,
          isolateWorktree,
          enabled: true,
          ...(model ? { modelProfileId: model } : {})
        }
        await addSeat(draft)
      }
      requestClose()
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
          <span>{isEdit ? `编辑岗位 · ${seat?.name}` : '添加岗位'}</span>
          <button type="button" className="room-dialog-close" onClick={requestClose}>×</button>
        </div>
        <div className="room-dialog-body">
          <div className="room-seat-card-row">
            <input className="room-seat-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="名字（如 小前）" />
            <input className="room-seat-role" value={role} onChange={(e) => setRole(e.target.value)} placeholder="职责（如 前端工程师）" />
          </div>
          <textarea
            className="room-seat-persona"
            value={persona}
            rows={3}
            onChange={(e) => setPersona(e.target.value)}
            placeholder="岗位说明书 / 人设（可选）"
          />
          <div className="room-seat-card-row">
            <RoomSelect
              className="room-seat-model-select"
              value={model}
              options={[{ value: '', label: '默认模型' }, ...profiles.map((p) => ({ value: p.id, label: p.name }))]}
              onChange={setModel}
            />
            <label className="room-seat-readonly">
              <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
              只读岗位
            </label>
            <label className="room-seat-readonly" title="若该岗位工作区是 git 仓库，开工前自动建独立副本，多岗位改同一仓库不互相踩踏">
              <input type="checkbox" checked={isolateWorktree} onChange={(e) => setIsolateWorktree(e.target.checked)} />
              防冲突隔离（高级）
            </label>
          </div>
          {error && <div className="room-dialog-error">{error}</div>}
        </div>
        <div className="room-dialog-footer">
          <button type="button" className="room-dialog-cancel" onClick={requestClose}>取消</button>
          <button type="button" className="room-dialog-create" disabled={submitting} onClick={() => void submit()}>
            {submitting ? '保存中…' : (isEdit ? '保存' : '添加')}
          </button>
        </div>
      </div>
    </div>
  )
}
