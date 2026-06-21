import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface PopoverMenuItem {
  label?: string
  shortcut?: string
  danger?: boolean
  disabled?: boolean
  separator?: boolean
  onClick?: () => void
}

interface PopoverMenuProps {
  x: number
  y: number
  items: PopoverMenuItem[]
  onClose: () => void
  
  origin?: 'top-left' | 'top-right'
}

export default function PopoverMenu({
  x,
  y,
  items,
  onClose,
  origin = 'top-left'
}: PopoverMenuProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  const [ready, setReady] = useState(false)
  const [exiting, setExiting] = useState(false)

  const requestClose = (): void => {
    if (exiting) return
    setExiting(true)
  }

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const MARGIN = 8
    const vw = window.innerWidth
    const vh = window.innerHeight

    let nx = origin === 'top-right' ? x - rect.width : x
    if (nx + rect.width > vw - MARGIN) nx = vw - rect.width - MARGIN
    if (nx < MARGIN) nx = MARGIN

    let ny = y
    if (ny + rect.height > vh - MARGIN) {
      const above = y - rect.height
      if (above >= MARGIN) {
        ny = above
      } else {
        ny = Math.max(MARGIN, vh - rect.height - MARGIN)
      }
    }
    if (ny < MARGIN) ny = MARGIN

    setPos({ x: nx, y: ny })
    setReady(true)
  }, [x, y, origin, items])

  useEffect(() => {
    const onOutside = (e: Event): void => {
      if (!ref.current?.contains(e.target as Node)) requestClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        // 关菜单即消费 Esc，避免连带触发上层“退出对话”
        e.preventDefault()
        requestClose()
      }
    }
    window.addEventListener('mousedown', onOutside, true)
    window.addEventListener('contextmenu', onOutside, true)
    window.addEventListener('resize', requestClose)
    window.addEventListener('blur', requestClose)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onOutside, true)
      window.removeEventListener('contextmenu', onOutside, true)
      window.removeEventListener('resize', requestClose)
      window.removeEventListener('blur', requestClose)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [])

  const onAnimationEnd = (e: React.AnimationEvent<HTMLDivElement>): void => {
    if (exiting && e.currentTarget === e.target) onClose()
  }

  return createPortal(
    <div
      ref={ref}
      className={`lc-popover${exiting ? ' is-exiting' : ''}`}
      style={{ left: pos.x, top: pos.y, visibility: ready ? 'visible' : 'hidden' }}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
      onAnimationEnd={onAnimationEnd}
    >
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} className="lc-popover-sep" />
        ) : (
          <div
            key={i}
            className={`lc-popover-item${item.danger ? ' danger' : ''}${
              item.disabled ? ' disabled' : ''
            }`}
            onClick={() => {
              if (item.disabled || exiting) return
              requestClose()
              item.onClick?.()
            }}
          >
            <span className="lc-popover-label">{item.label}</span>
            {item.shortcut && <span className="lc-popover-shortcut">{item.shortcut}</span>}
          </div>
        )
      )}
    </div>,
    document.body
  )
}
