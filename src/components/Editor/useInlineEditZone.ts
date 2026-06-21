import { useEffect } from 'react'
import type { editor } from 'monaco-editor'
import { useInlineEditStore } from '@/stores/inlineEditStore'

const RESERVE_PX = 92

/**
 * Reserves vertical space above the edited region using a Monaco view zone so the
 * floating inline-edit widget never covers code, and keeps the widget aligned to
 * that gap while scrolling/resizing.
 */
export function useInlineEditZone(
  ed: editor.IStandaloneCodeEditor | null,
  tabPath: string
): void {
  const active = useInlineEditStore((s) => s.active)
  const path = useInlineEditStore((s) => s.path)
  const anchorLine = useInlineEditStore((s) => s.anchorLine)
  const width = useInlineEditStore((s) => s.width)

  const on = active && path === tabPath

  useEffect(() => {
    if (!ed || !on) return

    let zoneId: string | null = null
    ed.changeViewZones((accessor) => {
      const dom = document.createElement('div')
      zoneId = accessor.addZone({
        afterLineNumber: Math.max(0, anchorLine - 1),
        heightInPx: RESERVE_PX,
        domNode: dom,
        suppressMouseDown: true
      })
    })

    const reposition = (): void => {
      const dom = ed.getDomNode()
      const pos = ed.getScrolledVisiblePosition({ lineNumber: anchorLine, column: 1 })
      if (!dom || !pos) return
      const rect = dom.getBoundingClientRect()
      
      const top = rect.top + pos.top - RESERVE_PX + 6
      const left = rect.left + 60
      const w = Math.min(560, Math.max(360, rect.width - 120))
      useInlineEditStore.getState().setPosition({ top, left, width: w })
    }
    reposition()

    const d1 = ed.onDidScrollChange(reposition)
    const d2 = ed.onDidLayoutChange(reposition)

    return () => {
      d1.dispose()
      d2.dispose()
      if (zoneId !== null) {
        ed.changeViewZones((accessor) => accessor.removeZone(zoneId as string))
      }
    }
  }, [ed, on, anchorLine, width])
}
