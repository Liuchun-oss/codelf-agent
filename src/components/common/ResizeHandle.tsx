import { useRef, type PointerEvent } from 'react'

type Edge = 'left' | 'right' | 'top' | 'bottom'

interface Props {
  edge: Edge
  
  getSize: () => number
  
  onResize: (size: number) => void
  title?: string
}

const AXIS: Record<Edge, 'x' | 'y'> = { left: 'x', right: 'x', top: 'y', bottom: 'y' }


const DIR: Record<Edge, 1 | -1> = { left: -1, right: 1, top: -1, bottom: 1 }

export default function ResizeHandle({ edge, getSize, onResize, title }: Props): JSX.Element {
  const startPos = useRef(0)
  const startSize = useRef(0)
  const dragging = useRef(false)
  const axis = AXIS[edge]
  const dir = DIR[edge]

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    startPos.current = axis === 'x' ? e.clientX : e.clientY
    startSize.current = getSize()
    dragging.current = true
    e.currentTarget.classList.add('dragging')
    document.body.classList.add(axis === 'x' ? 'resizing-x' : 'resizing-y')
  }

  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return
    const cur = axis === 'x' ? e.clientX : e.clientY
    onResize(startSize.current + (cur - startPos.current) * dir)
  }

  const end = (e: PointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return
    dragging.current = false
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    e.currentTarget.classList.remove('dragging')
    document.body.classList.remove('resizing-x', 'resizing-y')
  }

  return (
    <div
      className={`resize-handle resize-${edge}`}
      title={title}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
    />
  )
}
