import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'


export interface LazyRowProps {
  scrollRef: RefObject<HTMLDivElement | null>
  forceMounted?: boolean
  estimatedHeight?: number
  children: ReactNode
}

const ROOT_MARGIN = '800px 0px'
const DEFAULT_ESTIMATED_HEIGHT = 120

export default function LazyRow({
  scrollRef,
  forceMounted = false,
  estimatedHeight = DEFAULT_ESTIMATED_HEIGHT,
  children
}: LazyRowProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(true)
  const heightRef = useRef<number>(estimatedHeight)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const root = scrollRef.current ?? null
    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (!entry) return
        if (entry.isIntersecting) {
          setVisible(true)
        } else {
          
          const h = el.getBoundingClientRect().height
          if (h > 0) heightRef.current = h
          setVisible(false)
        }
      },
      { root, rootMargin: ROOT_MARGIN, threshold: 0 }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [scrollRef])

  
  useEffect(() => {
    if (!visible) return
    const el = ref.current
    if (!el) return
    const h = el.getBoundingClientRect().height
    if (h > 0) heightRef.current = h
  })

  const mounted = forceMounted || visible
  return (
    <div ref={ref} style={mounted ? undefined : { minHeight: heightRef.current }}>
      {mounted ? children : null}
    </div>
  )
}
