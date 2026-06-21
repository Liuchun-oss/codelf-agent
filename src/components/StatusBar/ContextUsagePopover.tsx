import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { TokenUsage } from '@shared/agentTypes'
import type { ContextUsageBreakdown } from '@shared/contextUsage'
import { formatTokenCount, segmentSharePercent } from '@shared/contextUsage'

interface ContextUsagePopoverProps {
  open: boolean
  onClose: () => void
  breakdown?: ContextUsageBreakdown | null
  usage?: TokenUsage | null
  anchorRef?: React.RefObject<HTMLElement>
}


function barVisibleSegments(
  segments: ContextUsageBreakdown['segments'],
  total: number
): ContextUsageBreakdown['segments'] {
  return segments.filter((s) => s.tokens > 0 && (s.tokens >= 50 || segmentSharePercent(s.tokens, total) >= 1))
}

export default function ContextUsagePopover({
  open,
  onClose,
  breakdown,
  usage,
  anchorRef
}: ContextUsagePopoverProps): JSX.Element | null {
  const [mounted, setMounted] = useState(open)
  const [exiting, setExiting] = useState(false)
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const exitedRef = useRef(false)

  useEffect(() => {
    if (open) {
      setMounted(true)
      setExiting(false)
      exitedRef.current = false
    } else if (mounted) {
      setExiting(true)
    }
  }, [open, mounted])

  useEffect(() => {
    if (!open || !mounted) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        // 关弹层即消费 Esc，避免连带触发上层“退出对话”
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, mounted, onClose])

  useLayoutEffect(() => {
    if (!open || !mounted || !anchorRef?.current) return
    const compute = (): void => {
      const rect = anchorRef.current?.getBoundingClientRect()
      if (!rect) return
      const margin = 8
      const width = panelRef.current?.offsetWidth ?? 360
      const center = rect.left + rect.width / 2
      const maxLeft = globalThis.innerWidth - width - margin
      const left = Math.max(margin, Math.min(center - width / 2, maxLeft))
      setPos({
        left,
        bottom: globalThis.innerHeight - rect.top + margin
      })
    }
    compute()
    const raf = requestAnimationFrame(compute)
    globalThis.addEventListener('resize', compute)
    globalThis.addEventListener('scroll', compute, true)
    return () => {
      cancelAnimationFrame(raf)
      globalThis.removeEventListener('resize', compute)
      globalThis.removeEventListener('scroll', compute, true)
    }
  }, [open, mounted, anchorRef])

  if (!mounted) return null

  const onAnimEnd = (e: React.AnimationEvent<HTMLDivElement>): void => {
    if (!exiting || e.currentTarget !== e.target) return
    const name = e.animationName
    if (!name.includes('context-usage-pop-out') && !name.includes('context-usage-backdrop-out')) return
    if (exitedRef.current) return
    exitedRef.current = true
    setMounted(false)
    setExiting(false)
  }

  const panel = (
    <div
      ref={panelRef}
      className={`context-usage-panel${anchorRef ? ' anchored' : ''}${exiting ? ' is-exiting' : ''}`}
      role="dialog"
      aria-label="上下文用量"
      onAnimationEnd={onAnimEnd}
      style={
        anchorRef && pos
          ? { left: pos.left, bottom: pos.bottom, right: 'auto', transform: 'none' }
          : undefined
      }
    >
      <header className="context-usage-header">
        <span className="context-usage-title">上下文</span>
        <button type="button" className="context-usage-close" onClick={onClose} aria-label="关闭">
          ×
        </button>
      </header>
      {breakdown ? renderUsageBody(breakdown, usage) : <div className="context-usage-empty">暂无用量数据</div>}
    </div>
  )

  return createPortal(
    <>
      <div
        className={`context-usage-backdrop${exiting ? ' is-exiting' : ''}`}
        onClick={onClose}
        aria-hidden
        onAnimationEnd={onAnimEnd}
      />
      {panel}
    </>,
    document.body
  )
}

function renderUsageBody(
  breakdown: ContextUsageBreakdown,
  usage?: TokenUsage | null
): JSX.Element {
  const total = breakdown.totalTokens
  const window = breakdown.contextWindow
  const listSegments = breakdown.segments.filter((s) => s.tokens > 0)
  const barSegments = barVisibleSegments(listSegments, total)
  const usedPct = Math.max(0, Math.min(100, breakdown.percentFull))
  const hasPromptCache = usage?.cacheReadInputTokens !== undefined || usage?.cacheCreationInputTokens !== undefined
  const promptCacheHitRate = usage?.promptCacheHitRate

  return (
    <>
      <div className="context-usage-summary">
        <span className="context-usage-percent">已用 {breakdown.percentFull}%</span>
        <span className="context-usage-total">
          约 {formatTokenCount(total)} / {formatTokenCount(window)} token
        </span>
      </div>

      {hasPromptCache && promptCacheHitRate !== undefined ? (
        <div className="context-usage-cache" aria-label="上下文缓存命中率">
          <span className="context-usage-cache-title">
            上下文缓存已命中 {promptCacheHitRate.toFixed(promptCacheHitRate % 1 === 0 ? 0 : 1)}%
          </span>
        </div>
      ) : null}

      <div className="context-usage-bar-track" aria-hidden>
        <div className="context-usage-bar-used" style={{ width: `${usedPct}%` }}>
          {barSegments.length > 0 ? (
            barSegments.map((s) => (
              <span
                key={s.id}
                className="context-usage-bar-seg"
                style={{
                  flexGrow: s.tokens,
                  backgroundColor: s.color
                }}
                title={s.label}
              />
            ))
          ) : (
            <span className="context-usage-bar-seg context-usage-bar-seg-fallback" />
          )}
        </div>
      </div>

      <ul className="context-usage-list">
        {listSegments.map((s) => (
          <li key={s.id} className="context-usage-row">
            <span className="context-usage-swatch" style={{ backgroundColor: s.color }} />
            <span className="context-usage-label">{s.label}</span>
            <span className="context-usage-value">{formatTokenCount(s.tokens)}</span>
          </li>
        ))}
      </ul>
    </>
  )
}
