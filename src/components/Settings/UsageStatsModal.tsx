import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  ProviderKind,
  ProviderProfileSummary,
  UsageStatsResult,
  UsageStatsQuery
} from '@shared/agentTypes'
import { formatTokenCount } from '@shared/contextUsage'

interface UsageStatsModalProps {
  open: boolean
  onClose: () => void
}

type RangePreset = 'today' | '7d' | '30d' | 'all' | 'custom'

const KIND_LABEL: Record<ProviderKind, string> = {
  openai: 'OpenAI',
  'azure-openai': 'Azure OpenAI',
  anthropic: 'Anthropic',
  'openai-compatible': 'OpenAI 兼容',
  deepseek: 'DeepSeek',
  dify: 'Dify'
}

const PRESET_LABEL: Record<RangePreset, string> = {
  today: '今天',
  '7d': '近 7 天',
  '30d': '近 30 天',
  all: '全部',
  custom: '自定义'
}

function startOfToday(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function dateInputValue(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function parseDateStart(value: string): number | undefined {
  if (!value) return undefined
  const d = new Date(`${value}T00:00:00`)
  return Number.isNaN(d.getTime()) ? undefined : d.getTime()
}

function parseDateEnd(value: string): number | undefined {
  if (!value) return undefined
  const d = new Date(`${value}T23:59:59.999`)
  return Number.isNaN(d.getTime()) ? undefined : d.getTime()
}

function buildQuery(
  preset: RangePreset,
  customFrom: string,
  customTo: string,
  profileId: string
): UsageStatsQuery {
  const now = Date.now()
  const base: UsageStatsQuery = profileId ? { profileId } : {}
  switch (preset) {
    case 'today':
      return { ...base, from: startOfToday(), to: now }
    case '7d':
      return { ...base, from: now - 7 * 24 * 60 * 60 * 1000, to: now }
    case '30d':
      return { ...base, from: now - 30 * 24 * 60 * 60 * 1000, to: now }
    case 'custom':
      return { ...base, from: parseDateStart(customFrom), to: parseDateEnd(customTo) }
    case 'all':
    default:
      return base
  }
}

export default function UsageStatsModal({ open, onClose }: UsageStatsModalProps): JSX.Element | null {
  const [preset, setPreset] = useState<RangePreset>('7d')
  const [customFrom, setCustomFrom] = useState(() => dateInputValue(Date.now() - 7 * 24 * 60 * 60 * 1000))
  const [customTo, setCustomTo] = useState(() => dateInputValue(Date.now()))
  const [profileId, setProfileId] = useState('')
  const [profiles, setProfiles] = useState<ProviderProfileSummary[]>([])
  const [stats, setStats] = useState<UsageStatsResult | null>(null)
  const [loading, setLoading] = useState(false)

  const query = useMemo(
    () => buildQuery(preset, customFrom, customTo, profileId),
    [preset, customFrom, customTo, profileId]
  )

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await window.lc.aiGetUsageStats(query)
      setStats(res)
    } finally {
      setLoading(false)
    }
  }, [query])

  useEffect(() => {
    if (!open) return
    void load()
  }, [open, load])

  useEffect(() => {
    if (!open) return
    void window.lc.aiListProfiles().then(setProfiles)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const rows = stats?.perProfile ?? []
  const total = stats?.total

  return createPortal(
    <div className="usage-stats-backdrop" onClick={onClose} role="presentation">
      <div
        className="usage-stats-modal"
        role="dialog"
        aria-label="Token 用量统计"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="usage-stats-header">
          <span className="usage-stats-title">Token 用量统计</span>
          <button type="button" className="usage-stats-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>

        <div className="usage-stats-filter">
          <select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
            <option value="">全部模型</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select value={preset} onChange={(e) => setPreset(e.target.value as RangePreset)}>
            {(Object.keys(PRESET_LABEL) as RangePreset[]).map((k) => (
              <option key={k} value={k}>
                {PRESET_LABEL[k]}
              </option>
            ))}
          </select>
          {preset === 'custom' && (
            <div className="usage-stats-custom">
              <input type="date" value={customFrom} max={customTo} onChange={(e) => setCustomFrom(e.target.value)} />
              <span className="usage-stats-custom-sep">至</span>
              <input type="date" value={customTo} min={customFrom} onChange={(e) => setCustomTo(e.target.value)} />
            </div>
          )}
        </div>

        <div className="usage-stats-body">
          {loading ? (
            <div className="usage-stats-empty">加载中…</div>
          ) : rows.length === 0 ? (
            <div className="usage-stats-empty">该时间范围内暂无用量记录</div>
          ) : (
            <table className="usage-stats-table">
              <thead>
                <tr>
                  <th className="usage-stats-col-model">模型</th>
                  <th className="usage-stats-col-num">输入</th>
                  <th className="usage-stats-col-num">输出</th>
                  <th className="usage-stats-col-num">合计</th>
                  <th className="usage-stats-col-num">轮次</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.profileId}>
                    <td className="usage-stats-col-model">
                      <span className="usage-stats-model-name">{r.name ?? r.model ?? '（已删除）'}</span>
                      <span className="usage-stats-model-meta">
                        {KIND_LABEL[r.kind] ?? r.kind}
                        {r.model ? ` · ${r.model}` : ''}
                      </span>
                    </td>
                    <td className="usage-stats-col-num">{formatTokenCount(r.inputTokens)}</td>
                    <td className="usage-stats-col-num">{formatTokenCount(r.outputTokens)}</td>
                    <td className="usage-stats-col-num">{formatTokenCount(r.totalTokens)}</td>
                    <td className="usage-stats-col-num">{r.turns}</td>
                  </tr>
                ))}
              </tbody>
              {total && (
                <tfoot>
                  <tr>
                    <td className="usage-stats-col-model">总计</td>
                    <td className="usage-stats-col-num">{formatTokenCount(total.inputTokens)}</td>
                    <td className="usage-stats-col-num">{formatTokenCount(total.outputTokens)}</td>
                    <td className="usage-stats-col-num">{formatTokenCount(total.totalTokens)}</td>
                    <td className="usage-stats-col-num">{total.turns}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
