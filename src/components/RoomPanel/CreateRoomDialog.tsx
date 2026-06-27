import { useEffect, useState } from 'react'
import type { RoomDraft, Seat, SpeakingPolicy } from '@shared/roomTypes'
import type { ProviderProfileSummary } from '@shared/agentTypes'
import { useRoomStore } from '../../stores/roomStore'
import { ROOM_TEMPLATES, type RoomTemplate } from './roomTemplates'

// 建群表单：填群名、主管人设（§5.5 可空→出厂默认），增删工人岗位（名字/职责/人设/模型/只读）。
// 生成 RoomDraft 调 room:create，后端自动补工作区目录、禁用工人 run_subagent。

type SeatDraft = Omit<Seat, 'lastSeenUtteranceSeq' | 'workspaceRoot'> & { workspaceRoot?: string | null }

function freshWorker(idx: number): SeatDraft {
  return {
    id: `seat-${Date.now().toString(36)}-${idx}`,
    name: '',
    role: '',
    personaPrompt: '',
    readOnly: false,
    enabled: true
  }
}

export default function CreateRoomDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const createRoom = useRoomStore((s) => s.createRoom)
  const [title, setTitle] = useState('')
  const [hostName, setHostName] = useState('小灵')
  const [hostPersona, setHostPersona] = useState('')
  const [hostModel, setHostModel] = useState('')
  const [workers, setWorkers] = useState<SeatDraft[]>([freshWorker(0)])
  const [bindWeixin, setBindWeixin] = useState(false)
  const [policy, setPolicy] = useState<SpeakingPolicy>('host-routed')
  const [maxRounds, setMaxRounds] = useState(0)
  const [profiles, setProfiles] = useState<ProviderProfileSummary[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void window.lc.aiListProfiles().then(setProfiles).catch(() => setProfiles([]))
  }, [])

  const updateWorker = (id: string, patch: Partial<SeatDraft>): void => {
    setWorkers((ws) => ws.map((w) => (w.id === id ? { ...w, ...patch } : w)))
  }

  const applyTemplate = (t: RoomTemplate): void => {
    setTitle(t.title)
    setHostName(t.hostName)
    setHostPersona(t.hostPersona)
    setPolicy(t.speakingPolicy)
    setWorkers(t.workers.map((w, i) => ({
      ...freshWorker(i),
      name: w.name,
      role: w.role,
      personaPrompt: w.personaPrompt,
      readOnly: !!w.readOnly
    })))
  }

  const submit = async (): Promise<void> => {
    if (!title.trim()) { setError('请填写群名'); return }
    const validWorkers = workers.filter((w) => w.name.trim() && w.role.trim())
    if (validWorkers.length === 0) { setError('至少添加一个有名字和职责的岗位'); return }
    setSubmitting(true)
    setError('')
    try {
      const hostSeat: SeatDraft = {
        id: 'host',
        name: hostName.trim() || '小灵',
        role: '项目经理',
        isHost: true,
        personaPrompt: hostPersona.trim(),
        workspaceRoot: null,
        readOnly: false,
        enabled: true,
        ...(hostModel ? { modelProfileId: hostModel } : {})
      }
      const draft: RoomDraft = {
        title: title.trim(),
        hostSeatId: 'host',
        seats: [hostSeat, ...validWorkers],
        speakingPolicy: policy,
        maxRounds: Number.isFinite(maxRounds) && maxRounds > 0 ? Math.floor(maxRounds) : 0,
        ...(bindWeixin ? { weixinBinding: { conversationId: 'weixin' } } : {})
      }
      await createRoom(draft)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setSubmitting(false)
    }
  }

  return (
    <div className="room-dialog-overlay" onClick={onClose}>
      <div className="room-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="room-dialog-header">
          <span>新建群聊</span>
          <button type="button" className="room-dialog-close" onClick={onClose}>×</button>
        </div>

        <div className="room-dialog-body">
          <div className="room-templates">
            <span className="room-field-label">从模板开始（可选）</span>
            <div className="room-template-chips">
              {ROOM_TEMPLATES.map((t) => (
                <button key={t.key} type="button" className="room-template-chip" onClick={() => applyTemplate(t)}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <div className="room-dialog-columns">
            <div className="room-dialog-col">
              <label className="room-field">
            <span className="room-field-label">群名</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如：产品团队" />
          </label>

          <label className="room-field">
            <span className="room-field-label">发言策略</span>
            <select value={policy} onChange={(e) => setPolicy(e.target.value as SpeakingPolicy)}>
              <option value="host-routed">主管分派（host-routed）— 主管 @ 谁谁发言</option>
              <option value="round-robin">轮流接力（round-robin）— 按顺序逐个发言</option>
              <option value="free">自由讨论（free）— 发言末尾 @ 谁谁接力</option>
            </select>
          </label>

          <label className="room-field">
            <span className="room-field-label">失控刹车 maxRounds（0 = 不限制）</span>
            <input
              type="number"
              min={0}
              value={maxRounds}
              onChange={(e) => setMaxRounds(Number(e.target.value))}
              placeholder="0"
            />
            <span className="room-field-hint">连锁发言超过 N 轮自动停，防止团队反复刷屏烧 token。不确定就留 0。</span>
          </label>

          <div className="room-field-group">
            <div className="room-field-group-title">主管（群主）</div>
            <label className="room-field">
              <span className="room-field-label">名字</span>
              <input value={hostName} onChange={(e) => setHostName(e.target.value)} placeholder="小灵" />
            </label>
            <label className="room-field">
              <span className="room-field-label">人设</span>
              <textarea
                value={hostPersona}
                rows={2}
                onChange={(e) => setHostPersona(e.target.value)}
                placeholder="留空则用出厂默认：认真负责的项目管家"
              />
            </label>
            <label className="room-field">
              <span className="room-field-label">模型</span>
              <select value={hostModel} onChange={(e) => setHostModel(e.target.value)}>
                <option value="">默认（当前激活）</option>
                {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}（{p.model}）</option>)}
              </select>
            </label>
            <label className="room-seat-readonly">
              <input type="checkbox" checked={bindWeixin} onChange={(e) => setBindWeixin(e.target.checked)} />
              绑定微信（主管与微信同源，可用微信遥控团队）
            </label>
            {bindWeixin && (
              <div className="room-field-hint room-weixin-hint">
                绑定后，在微信里发「<code>/room 你的任务</code>」即可远程给团队派活；岗位的提问/审批会推到你微信，回一句就接着跑。回到桌面操作后会自动暂停微信推送，直到下次再用 <code>/room</code>。
                <br />
                注意：微信同时只能对接一个群。绑定本群会自动解绑其他已绑微信的群。
              </div>
            )}
          </div>
            </div>

            <div className="room-dialog-col">
          <div className="room-field-group">
            <div className="room-field-group-title">
              岗位
              <button type="button" className="room-add-seat" onClick={() => setWorkers((ws) => [...ws, freshWorker(ws.length)])}>
                + 添加岗位
              </button>
            </div>
            {workers.map((w) => (
              <div key={w.id} className="room-seat-card">
                <div className="room-seat-card-row">
                  <input
                    className="room-seat-name"
                    value={w.name}
                    onChange={(e) => updateWorker(w.id, { name: e.target.value })}
                    placeholder="名字（如 小前）"
                  />
                  <input
                    className="room-seat-role"
                    value={w.role}
                    onChange={(e) => updateWorker(w.id, { role: e.target.value })}
                    placeholder="职责（如 前端工程师）"
                  />
                  {workers.length > 1 && (
                    <button type="button" className="room-seat-del" onClick={() => setWorkers((ws) => ws.filter((x) => x.id !== w.id))}>删</button>
                  )}
                </div>
                <textarea
                  className="room-seat-persona"
                  value={w.personaPrompt}
                  rows={2}
                  onChange={(e) => updateWorker(w.id, { personaPrompt: e.target.value })}
                  placeholder="岗位说明书 / 人设（可选）"
                />
                <div className="room-seat-card-row">
                  <select value={w.modelProfileId ?? ''} onChange={(e) => updateWorker(w.id, { modelProfileId: e.target.value || undefined })}>
                    <option value="">默认模型</option>
                    {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <label className="room-seat-readonly">
                    <input type="checkbox" checked={w.readOnly} onChange={(e) => updateWorker(w.id, { readOnly: e.target.checked })} />
                    只读岗位
                  </label>
                  <label className="room-seat-readonly" title="若该岗位工作区是 git 仓库，开工前自动建独立副本，多岗位改同一仓库不互相踩踏（非 git 仓自动降级）">
                    <input type="checkbox" checked={!!w.isolateWorktree} onChange={(e) => updateWorker(w.id, { isolateWorktree: e.target.checked })} />
                    防冲突隔离（高级）
                  </label>
                </div>
              </div>
            ))}
          </div>
            </div>
          </div>

          {error && <div className="room-dialog-error">{error}</div>}
        </div>

        <div className="room-dialog-footer">
          <button type="button" className="room-dialog-cancel" onClick={onClose}>取消</button>
          <button type="button" className="room-dialog-create" disabled={submitting} onClick={() => void submit()}>
            {submitting ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </div>
  )
}
