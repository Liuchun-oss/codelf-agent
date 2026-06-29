import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface RoomSelectOption {
  value: string
  label: string
}

// 自定义下拉框（替代原生 <select>）：原生 select 的展开列表由系统渲染，CSS 动画管不到，
// 这里用 div 模拟选项面板，带平滑展开/收起缓动。受控用法同 select：传 value / options / onChange。
// 面板用 Portal + fixed 定位渲染到 body，避免被弹窗滚动容器（overflow:auto）裁剪。
export default function RoomSelect({
  value,
  options,
  onChange,
  className,
  placeholder
}: {
  value: string
  options: RoomSelectOption[]
  onChange: (value: string) => void
  className?: string
  placeholder?: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [closing, setClosing] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [rect, setRect] = useState<{ left: number; top: number; width: number; below: boolean } | null>(null)
  const current = options.find((o) => o.value === value)

  const measure = (): void => {
    const el = rootRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const spaceBelow = window.innerHeight - r.bottom
    const below = spaceBelow > 240 || spaceBelow > r.top
    setRect({ left: r.left, top: below ? r.bottom + 4 : r.top - 4, width: r.width, below })
  }

  useLayoutEffect(() => {
    if (open) measure()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (!rootRef.current?.contains(t) && !panelRef.current?.contains(t)) startClose()
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') startClose() }
    const onScroll = (): void => measure()
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open])

  const startClose = (): void => setClosing(true)
  const pick = (v: string): void => {
    onChange(v)
    startClose()
  }
  const onPanelAnimEnd = (e: React.AnimationEvent): void => {
    if (e.currentTarget !== e.target) return
    if (closing) { setOpen(false); setClosing(false) }
  }

  return (
    <div ref={rootRef} className={`room-select${open ? ' open' : ''}${className ? ` ${className}` : ''}`}>
      <button
        type="button"
        className="room-select-trigger"
        onClick={() => (open ? startClose() : setOpen(true))}
        title={current?.label ?? placeholder}
      >
        <span className="room-select-value">{current?.label ?? placeholder ?? ''}</span>
        <span className="room-select-arrow" aria-hidden>▾</span>
      </button>
      {open && rect && createPortal(
        <div
          ref={panelRef}
          className={`room-select-panel${closing ? ' closing' : ''}${rect.below ? '' : ' above'}`}
          style={{
            position: 'fixed',
            left: rect.left,
            top: rect.below ? rect.top : undefined,
            bottom: rect.below ? undefined : window.innerHeight - rect.top,
            width: rect.width
          }}
          onAnimationEnd={onPanelAnimEnd}
        >
          <div className="room-select-panel-inner">
            {options.map((o) => (
              <button
                type="button"
                key={o.value}
                className={`room-select-option${o.value === value ? ' selected' : ''}`}
                onClick={() => pick(o.value)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
