import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { APP_MENUS, CHAT_MENUS, RUN_MENU_INDEX, getRunMenuItems } from '@/menus/appMenus'
import { useBuildStore } from '@/stores/buildStore'
import type { PopoverMenuItem } from '@/components/common/PopoverMenu'

interface AppMenubarPanelProps {
  activeIndex: number
  buttonRefs: React.MutableRefObject<(HTMLButtonElement | null)[]>
  /** true = 对话模式菜单（对话/视图/终端/帮助）；false/缺省 = IDE 菜单 */
  chat?: boolean

  requestCloseRef?: React.MutableRefObject<(() => void) | null>
  
  onClosing?: () => void
  onClose: () => void
}

function computePos(
  index: number,
  buttonRefs: React.MutableRefObject<(HTMLButtonElement | null)[]>,
  panel?: HTMLDivElement | null
): { x: number; y: number } {
  const btn = buttonRefs.current[index]
  if (!btn) return { x: 0, y: 0 }
  const rect = btn.getBoundingClientRect()
  let nx = Math.round(rect.left)
  const ny = Math.round(rect.bottom)
  if (panel) {
    const pw = panel.offsetWidth
    if (nx + pw > window.innerWidth) nx = Math.max(0, window.innerWidth - pw - 4)
  }
  return { x: nx, y: ny }
}

function MenuItems({
  items,
  exiting,
  onAction
}: {
  items: PopoverMenuItem[]
  exiting: boolean
  onAction: () => void
}): JSX.Element {
  return (
    <>
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
              onAction()
              item.onClick?.()
            }}
          >
            <span className="lc-popover-label">{item.label}</span>
            {item.shortcut && <span className="lc-popover-shortcut">{item.shortcut}</span>}
          </div>
        )
      )}
    </>
  )
}

export default function AppMenubarPanel({
  activeIndex,
  buttonRefs,
  chat,
  requestCloseRef,
  onClosing,
  onClose
}: AppMenubarPanelProps): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const prevIndexRef = useRef(activeIndex)
  const hasOpenedRef = useRef(false)
  
  const buildPlans = useBuildStore((s) => s.plans)
  const [pos, setPos] = useState(() => computePos(activeIndex, buttonRefs))
  const [phase, setPhase] = useState<'opening' | 'ready' | 'exiting'>('opening')
  const [slideDir, setSlideDir] = useState(0)
  
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null)

  const requestClose = (): void => {
    if (phase === 'exiting') return
    onClosing?.()
    setPhase('exiting')
  }

  if (requestCloseRef) requestCloseRef.current = requestClose

  useEffect(() => {
    return () => {
      if (requestCloseRef) requestCloseRef.current = null
    }
  }, [requestCloseRef])

  const measureContent = (): { w: number; h: number } => {
    const el = measureRef.current
    if (!el) return { w: 190, h: 0 }
    return {
      w: Math.ceil(el.scrollWidth),
      h: Math.ceil(el.scrollHeight)
    }
  }

  const updatePosition = (index: number): void => {
    setPos(computePos(index, buttonRefs, panelRef.current))
  }

  const syncLayout = (index: number): void => {
    setDims(measureContent())
    updatePosition(index)
  }

  useLayoutEffect(() => {
    syncLayout(activeIndex)
    requestAnimationFrame(() => syncLayout(activeIndex))
  }, [])

  useLayoutEffect(() => {
    if (!hasOpenedRef.current) {
      hasOpenedRef.current = true
      prevIndexRef.current = activeIndex
      syncLayout(activeIndex)
      requestAnimationFrame(() => syncLayout(activeIndex))
      return
    }
    const prev = prevIndexRef.current
    if (prev !== activeIndex) {
      setSlideDir(activeIndex > prev ? 1 : activeIndex < prev ? -1 : 0)
      
      setPhase((p) => (p === 'opening' ? 'ready' : p))
    }
    prevIndexRef.current = activeIndex
    updatePosition(activeIndex)
    
    requestAnimationFrame(() => {
      setDims(measureContent())
      updatePosition(activeIndex)
    })
  }, [activeIndex, buttonRefs])

  useLayoutEffect(() => {
    if (dims) updatePosition(activeIndex)
  }, [dims, activeIndex, buttonRefs])

  
  useLayoutEffect(() => {
    if (!chat && activeIndex === RUN_MENU_INDEX) {
      requestAnimationFrame(() => syncLayout(activeIndex))
    }
    
  }, [buildPlans, activeIndex])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (panelRef.current?.contains(t)) return
      if (buttonRefs.current.some((btn) => btn?.contains(t))) return
      requestClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') requestClose()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('contextmenu', onDown, true)
    window.addEventListener('resize', requestClose)
    window.addEventListener('blur', requestClose)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('contextmenu', onDown, true)
      window.removeEventListener('resize', requestClose)
      window.removeEventListener('blur', requestClose)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [buttonRefs])

  const onPanelAnimationEnd = (e: React.AnimationEvent<HTMLDivElement>): void => {
    if (e.currentTarget !== e.target) return
    const name = e.animationName
    if (phase === 'exiting' && name.includes('menubar-out')) onClose()
    if (phase === 'opening' && name.includes('menubar-expand')) setPhase('ready')
  }

  const onSizeTransitionEnd = (): void => {
    updatePosition(activeIndex)
  }

  const innerStyle = {
    '--menubar-slide-x': `${slideDir * 10}px`
  } as CSSProperties

  const sizeStyle: CSSProperties | undefined = dims
    ? { width: dims.w, height: dims.h }
    : undefined

  const items = chat
    ? CHAT_MENUS[activeIndex] ?? []
    : activeIndex === RUN_MENU_INDEX
      ? getRunMenuItems()
      : APP_MENUS[activeIndex] ?? []

  return (
    <div
      ref={panelRef}
      className={`lc-menubar-panel${phase === 'opening' ? ' is-opening' : ''}${
        phase === 'ready' ? ' can-slide-left' : ''
      }${phase === 'exiting' ? ' is-exiting' : ''}`}
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
      onAnimationEnd={onPanelAnimationEnd}
    >
      <div
        className={`lc-menubar-panel-size${phase === 'ready' ? ' can-animate-size' : ''}`}
        style={sizeStyle}
        onTransitionEnd={(e) => {
          if (e.propertyName === 'width' || e.propertyName === 'height') onSizeTransitionEnd()
        }}
      >
        <div
          ref={measureRef}
          className={`lc-menubar-panel-inner${slideDir !== 0 ? ' is-switching' : ''}`}
          style={innerStyle}
        >
          <MenuItems items={items} exiting={phase === 'exiting'} onAction={requestClose} />
        </div>
      </div>
    </div>
  )
}
