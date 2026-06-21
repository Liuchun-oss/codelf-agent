import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'

interface AnimatedOverlayProps {
  open: boolean
  onClose?: () => void
  onExited?: () => void
  
  overlayClassName?: string
  
  panelClassName?: string
  clickOverlayToClose?: boolean
  children: ReactNode
}

export default function AnimatedOverlay({
  open,
  onClose,
  onExited,
  overlayClassName = '',
  panelClassName = '',
  clickOverlayToClose = false,
  children
}: AnimatedOverlayProps): JSX.Element | null {
  const [mounted, setMounted] = useState(open)
  const [exiting, setExiting] = useState(false)
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

  if (!mounted) return null

  const onOverlayMouseDown = (e: MouseEvent<HTMLDivElement>): void => {
    if (clickOverlayToClose && e.target === e.currentTarget) onClose?.()
  }

  const onAnimationEnd = (e: React.AnimationEvent<HTMLDivElement>): void => {
    if (!exiting || e.currentTarget !== e.target) return
    const name = e.animationName
    if (name.includes('overlay-out') || name.includes('panel-out')) {
      if (exitedRef.current) return
      exitedRef.current = true
      setMounted(false)
      setExiting(false)
      onExited?.()
    }
  }

  return (
    <div
      className={`lc-overlay${exiting ? ' is-exiting' : ''} ${overlayClassName}`.trim()}
      onMouseDown={onOverlayMouseDown}
      onAnimationEnd={onAnimationEnd}
    >
      <div
        className={`lc-overlay-panel${exiting ? ' is-exiting' : ''} ${panelClassName}`.trim()}
        onMouseDown={(e) => e.stopPropagation()}
        onAnimationEnd={onAnimationEnd}
      >
        {children}
      </div>
    </div>
  )
}
