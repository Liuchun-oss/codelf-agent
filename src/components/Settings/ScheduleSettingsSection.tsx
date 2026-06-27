import { useCallback, useEffect, useState } from 'react'
import type {
  ScheduledTask,
  ScheduledTaskDraft,
  ScheduleKind,
  DeliveryMode
} from '@shared/scheduleTypes'
import { MIN_EVERY_MS } from '@shared/scheduleTypes'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { SettingsGroup, SettingsRow, SettingsSwitch } from './SettingsRow'

type ScheduleType = 'at' | 'every' | 'cron'

interface FormState {
  id?: string
  name: string
  prompt: string
  scheduleType: ScheduleType
  atLocal: string
  everyValue: string
  everyUnit: 'minute' | 'hour' | 'day'
  cronExpr: string
  cronTz: string
  workspaceRoot: string | null
  delivery: DeliveryMode
  webhookUrl: string
  allowWrite: boolean
  carryLastOutput: boolean
}

const STATUS_LABEL: Record<string, { label: string; color: string }> = {
  ok: { label: '成功', color: '#30a46c' },
  error: { label: '失败', color: '#e5484d' },
  running: { label: '运行中', color: '#f5a623' },
  skipped: { label: '已跳过', color: '#8b8b8b' }
}

const EVERY_UNIT_MS = { minute: 60_000, hour: 3_600_000, day: 86_400_000 }

// 新建任务默认绑定当前打开的工作区，省去每次手动选择；可在表单里改或清空。
function currentWorkspaceRoot(): string | null {
  return useWorkspaceStore.getState().workspace?.path ?? null
}

function emptyForm(): FormState {
  return {
    name: '',
    prompt: '',
    scheduleType: 'cron',
    atLocal: '',
    everyValue: '30',
    everyUnit: 'minute',
    cronExpr: '0 9 * * *',
    cronTz: 'Asia/Shanghai',
    workspaceRoot: currentWorkspaceRoot(),
    delivery: 'weixin',
    webhookUrl: '',
    allowWrite: false,
    carryLastOutput: false
  }
}

// 把 datetime-local 字符串（本地时区无 Z）转成毫秒时间戳。
function localToMs(local: string): number {
  const t = new Date(local).getTime()
  return Number.isFinite(t) ? t : 0
}

function msToLocalInput(ms: number): string {
  const d = new Date(ms - new Date().getTimezoneOffset() * 60000)
  return d.toISOString().slice(0, 16)
}

function buildSchedule(f: FormState): ScheduleKind | null {
  if (f.scheduleType === 'at') {
    const at = localToMs(f.atLocal)
    return at > 0 ? { kind: 'at', at } : null
  }
  if (f.scheduleType === 'every') {
    const n = parseFloat(f.everyValue)
    if (!Number.isFinite(n) || n <= 0) return null
    const ms = Math.max(MIN_EVERY_MS, Math.round(n * EVERY_UNIT_MS[f.everyUnit]))
    return { kind: 'every', everyMs: ms }
  }
  const expr = f.cronExpr.trim()
  if (!expr) return null
  return { kind: 'cron', expr, ...(f.cronTz.trim() ? { tz: f.cronTz.trim() } : {}) }
}

function taskToForm(t: ScheduledTask): FormState {
  const base = emptyForm()
  base.id = t.id
  base.name = t.name
  base.prompt = t.prompt
  base.workspaceRoot = t.workspaceRoot ?? null
  base.delivery = t.delivery
  base.webhookUrl = t.webhookUrl ?? ''
  base.allowWrite = t.allowWrite
  base.carryLastOutput = t.carryLastOutput ?? false
  if (t.schedule.kind === 'at') {
    base.scheduleType = 'at'
    base.atLocal = msToLocalInput(t.schedule.at)
  } else if (t.schedule.kind === 'every') {
    base.scheduleType = 'every'
    const ms = t.schedule.everyMs
    if (ms % EVERY_UNIT_MS.day === 0) {
      base.everyUnit = 'day'
      base.everyValue = String(ms / EVERY_UNIT_MS.day)
    } else if (ms % EVERY_UNIT_MS.hour === 0) {
      base.everyUnit = 'hour'
      base.everyValue = String(ms / EVERY_UNIT_MS.hour)
    } else {
      base.everyUnit = 'minute'
      base.everyValue = String(ms / EVERY_UNIT_MS.minute)
    }
  } else {
    base.scheduleType = 'cron'
    base.cronExpr = t.schedule.expr
    base.cronTz = t.schedule.tz ?? ''
  }
  return base
}

function describeSchedule(s: ScheduleKind): string {
  if (s.kind === 'at') return `一次性 · ${new Date(s.at).toLocaleString()}`
  if (s.kind === 'every') {
    const min = Math.round(s.everyMs / 60000)
    if (min % 1440 === 0) return `每 ${min / 1440} 天`
    if (min % 60 === 0) return `每 ${min / 60} 小时`
    return `每 ${min} 分钟`
  }
  return `cron · ${s.expr}${s.tz ? ` (${s.tz})` : ''}`
}

function fmtTime(ms?: number): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleString()
}
export default function ScheduleSettingsSection(): JSX.Element {
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [form, setForm] = useState<FormState>(emptyForm())
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setTasks(await window.lc.schedule.list())
  }, [])

  useEffect(() => {
    void load()
    const offUpdate = window.lc.schedule.onTaskUpdate((task) => {
      setTasks((prev) => {
        const idx = prev.findIndex((t) => t.id === task.id)
        if (idx === -1) return [task, ...prev]
        const next = [...prev]
        next[idx] = task
        return next
      })
    })
    const offDeleted = window.lc.schedule.onTaskDeleted(({ id }) => {
      setTasks((prev) => prev.filter((t) => t.id !== id))
    })
    return () => {
      offUpdate()
      offDeleted()
    }
  }, [load])

  const patch = (p: Partial<FormState>): void => setForm((f) => ({ ...f, ...p }))

  const resetForm = (): void => {
    setForm(emptyForm())
    setEditing(false)
    setError(null)
  }

  const pickWorkspace = async (): Promise<void> => {
    const dir = await window.lc.schedule.pickWorkspace()
    if (dir) patch({ workspaceRoot: dir })
  }

  const submit = async (): Promise<void> => {
    setError(null)
    if (!form.name.trim()) {
      setError('请填写任务名称。')
      return
    }
    if (!form.prompt.trim()) {
      setError('请填写要执行的 prompt。')
      return
    }
    const schedule = buildSchedule(form)
    if (!schedule) {
      setError('调度设置无效，请检查时间 / 间隔 / cron 表达式。')
      return
    }
    if (form.delivery === 'webhook') {
      const u = form.webhookUrl.trim()
      if (!/^https?:\/\//i.test(u)) {
        setError('webhook 投递需要填写合法的 http/https URL。')
        return
      }
    }
    const draft: ScheduledTaskDraft = {
      name: form.name.trim(),
      prompt: form.prompt.trim(),
      schedule,
      workspaceRoot: form.workspaceRoot,
      delivery: form.delivery,
      webhookUrl: form.delivery === 'webhook' ? form.webhookUrl.trim() : undefined,
      allowWrite: form.allowWrite,
      carryLastOutput: form.carryLastOutput
    }
    setSaving(true)
    try {
      if (editing && form.id) {
        const updated = await window.lc.schedule.update(form.id, draft)
        if (updated && updated.enabled && updated.nextRunAt == null) {
          setError('调度无效（cron 表达式错误或时间已过去），任务无法触发。请修正。')
          await load()
          return
        }
      } else {
        const created = await window.lc.schedule.create(draft)
        if (created.enabled && created.nextRunAt == null) {
          await window.lc.schedule.remove(created.id)
          setError('调度无效（cron 表达式错误或时间已过去），未创建任务。请修正。')
          return
        }
      }
      await load()
      resetForm()
    } finally {
      setSaving(false)
    }
  }

  const startEdit = (t: ScheduledTask): void => {
    setForm(taskToForm(t))
    setEditing(true)
    setError(null)
  }

  return (
    <div className="settings-section-page">
      <SettingsGroup label="定时任务">
        <div className="settings-row stacked">
          <div className="settings-row-text">
            <strong>无人值守自动执行</strong>
            <small>
              按时间规则（一次性 / 固定间隔 / cron）自动唤起 AI 执行任务，结果可推送到微信。
              任务在独立会话中运行，默认只读；开启「允许写入」后会自动放行文件 / 命令操作（敏感路径仍被硬拦）。
            </small>
          </div>
        </div>
      </SettingsGroup>

      <SettingsGroup label={`任务列表（${tasks.length}）`}>
        {tasks.length === 0 ? (
          <div className="settings-inline-alert">暂无定时任务，在下方创建一个。</div>
        ) : (
          <div className="schedule-task-list">
            {tasks.map((t) => {
              const status = t.lastStatus ? STATUS_LABEL[t.lastStatus] : null
              return (
                <div key={t.id} className="schedule-task-item">
                  <div className="schedule-task-main">
                    <div className="schedule-task-title">
                      <strong>{t.name}</strong>
                      {status && (
                        <span className="schedule-task-status" style={{ color: status.color }}>
                          ● {status.label}
                        </span>
                      )}
                      {t.lastDeliveryStatus === 'failed' && (
                        <span className="schedule-task-status" style={{ color: '#e5484d' }}>
                          投递失败
                        </span>
                      )}
                    </div>
                    <div className="schedule-task-meta">
                      <span>{describeSchedule(t.schedule)}</span>
                      <span>下次：{t.enabled ? fmtTime(t.nextRunAt) : '已停用'}</span>
                      <span>上次：{fmtTime(t.lastRunAt)}</span>
                    </div>
                    {t.lastError && <div className="schedule-task-error">{t.lastError}</div>}
                  </div>
                  <div className="schedule-task-actions">
                    <SettingsSwitch
                      checked={t.enabled}
                      onChange={(v) => void window.lc.schedule.toggle(t.id, v)}
                    />
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={t.running}
                      onClick={() => void window.lc.schedule.runNow(t.id)}
                    >
                      {t.running ? '运行中…' : '立即运行'}
                    </button>
                    <button type="button" className="btn-secondary" onClick={() => startEdit(t)}>
                      编辑
                    </button>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => void window.lc.schedule.remove(t.id)}
                    >
                      删除
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup label={editing ? '编辑任务' : '新建任务'}>
        <SettingsRow
          title="任务名称"
          stacked
          control={
            <input
              type="text"
              placeholder="如：每日代码改动汇总"
              value={form.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
          }
        />
        <SettingsRow
          title="Prompt"
          description="到点后喂给 AI 的指令。"
          stacked
          control={
            <textarea
              rows={3}
              placeholder="如：汇总今天的 git 改动并简要点评"
              value={form.prompt}
              onChange={(e) => patch({ prompt: e.target.value })}
            />
          }
        />
        <SettingsRow
          title="调度方式"
          control={
            <select
              value={form.scheduleType}
              onChange={(e) => patch({ scheduleType: e.target.value as ScheduleType })}
            >
              <option value="cron">cron 表达式</option>
              <option value="every">固定间隔</option>
              <option value="at">指定时间（一次性）</option>
            </select>
          }
        />
        {form.scheduleType === 'at' && (
          <SettingsRow
            title="执行时间"
            description="到点执行一次，执行后自动删除。"
            control={
              <input
                type="datetime-local"
                value={form.atLocal}
                onChange={(e) => patch({ atLocal: e.target.value })}
              />
            }
          />
        )}
        {form.scheduleType === 'every' && (
          <SettingsRow
            title="间隔"
            description="最小间隔 1 分钟。"
            control={
              <span className="schedule-every-control">
                <input
                  type="number"
                  min={1}
                  value={form.everyValue}
                  onChange={(e) => patch({ everyValue: e.target.value })}
                />
                <select
                  value={form.everyUnit}
                  onChange={(e) => patch({ everyUnit: e.target.value as FormState['everyUnit'] })}
                >
                  <option value="minute">分钟</option>
                  <option value="hour">小时</option>
                  <option value="day">天</option>
                </select>
              </span>
            }
          />
        )}
        {form.scheduleType === 'cron' && (
          <>
            <SettingsRow
              title="cron 表达式"
              description="标准 5 段式，如 0 9 * * * 表示每天 9 点。"
              stacked
              control={
                <input
                  type="text"
                  placeholder="0 9 * * *"
                  value={form.cronExpr}
                  onChange={(e) => patch({ cronExpr: e.target.value })}
                />
              }
            />
            <SettingsRow
              title="时区"
              description="留空则用系统时区。"
              control={
                <input
                  type="text"
                  placeholder="Asia/Shanghai"
                  value={form.cronTz}
                  onChange={(e) => patch({ cronTz: e.target.value })}
                />
              }
            />
          </>
        )}
        {/* __SCHED_FORM_SCHEDULE__ */}
        <SettingsRow
          title="工作区目录"
          description="任务执行时 agent 干活的目录（决定它能读哪些文件、命令在哪跑）。默认跟随当前打开的工作区，可改。留空则为纯对话，不绑定任何目录、读不到项目文件。"
          stacked
          control={
            <span className="schedule-workspace-control">
              <input
                type="text"
                placeholder="（纯对话，无工作区）"
                value={form.workspaceRoot ?? ''}
                onChange={(e) => patch({ workspaceRoot: e.target.value || null })}
              />
              <button type="button" className="btn-secondary" onClick={() => void pickWorkspace()}>
                选择
              </button>
              {form.workspaceRoot && (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => patch({ workspaceRoot: null })}
                >
                  清除
                </button>
              )}
            </span>
          }
        />
        <SettingsRow
          title="结果投递"
          control={
            <select
              value={form.delivery}
              onChange={(e) => patch({ delivery: e.target.value as DeliveryMode })}
            >
              <option value="weixin">推送到微信</option>
              <option value="ui">桌面任务面板</option>
              <option value="webhook">Webhook (HTTP POST)</option>
              <option value="none">不通知</option>
            </select>
          }
        />
        {form.delivery === 'webhook' && (
          <SettingsRow
            title="Webhook URL"
            description="到点执行完成后 POST 一段 JSON（含 taskId / name / output）。仅支持 http/https。"
            stacked
            control={
              <input
                type="text"
                placeholder="https://example.com/hook"
                value={form.webhookUrl}
                onChange={(e) => patch({ webhookUrl: e.target.value })}
              />
            }
          />
        )}
        <SettingsRow
          title="允许写入 / 执行命令"
          description="关闭（默认）：只读，自动拒绝所有写文件 / 命令请求。开启：自动放行，敏感 / 系统路径仍被引擎硬拦。无人值守自动执行有风险，请谨慎开启。"
          control={
            <SettingsSwitch
              checked={form.allowWrite}
              onChange={(v) => patch({ allowWrite: v })}
            />
          }
        />
        <SettingsRow
          title="记住上次结果"
          description="开启后，下次执行会把上次的输出作为上下文带上（适合增量汇总类任务，如「只看新增的改动」）。不保留完整对话历史，不会膨胀。提醒类任务无需开启。"
          control={
            <SettingsSwitch
              checked={form.carryLastOutput}
              onChange={(v) => patch({ carryLastOutput: v })}
            />
          }
        />
        {/* __SCHED_FORM_OPTIONS__ */}
        {error && <div className="settings-inline-alert">{error}</div>}
        <div className="settings-actions">
          {editing && (
            <button type="button" className="btn-secondary" disabled={saving} onClick={resetForm}>
              取消编辑
            </button>
          )}
          <button type="button" className="btn" disabled={saving} onClick={() => void submit()}>
            {saving ? '保存中…' : editing ? '保存修改' : '创建任务'}
          </button>
        </div>
      </SettingsGroup>

      {/* __SCHED_FORM__ */}
    </div>
  )
}
