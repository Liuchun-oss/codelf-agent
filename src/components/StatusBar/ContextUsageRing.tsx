import type { ContextUsageBreakdown } from '@shared/contextUsage'
import { formatTokenCount } from '@shared/contextUsage'

interface ContextUsageRingProps {
  breakdown?: ContextUsageBreakdown | null
  open: boolean
  onClick: () => void
}


export default function ContextUsageRing({
  breakdown,
  open,
  onClick
}: ContextUsageRingProps): JSX.Element {
  const size = 18
  const stroke = 2.5
  const r = (size - stroke) / 2
  const cx = size / 2
  const circumference = 2 * Math.PI * r
  const pct = breakdown ? Math.max(0, Math.min(100, breakdown.percentFull)) : 0
  const offset = circumference * (1 - pct / 100)

  const title = breakdown
    ? `上下文 ${pct}% · 约 ${formatTokenCount(breakdown.totalTokens)} / ${formatTokenCount(breakdown.contextWindow)}`
    : '上下文用量 · 暂无数据'

  return (
    <button
      type="button"
      className={`statusbar-context-ring${open ? ' open' : ''}`}
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-expanded={open}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle
          className="statusbar-context-ring-bg"
          cx={cx}
          cy={cx}
          r={r}
          fill="none"
          strokeWidth={stroke}
        />
        <circle
          className="statusbar-context-ring-fg"
          cx={cx}
          cy={cx}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${cx} ${cx})`}
        />
      </svg>
    </button>
  )
}
