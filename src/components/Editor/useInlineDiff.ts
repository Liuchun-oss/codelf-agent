import { useEffect, useRef } from 'react'
import type { editor } from 'monaco-editor'
import type { InlineDiffEntry } from '@/stores/inlineDiffStore'


export function useInlineDiff(
  editorInstance: editor.IStandaloneCodeEditor | null,
  entry: InlineDiffEntry | undefined
): void {
  const viewZoneIds = useRef<string[]>([])
  const decorationIds = useRef<string[]>([])
  const widgetRef = useRef<editor.IContentWidget | null>(null)

  useEffect(() => {
    if (!editorInstance) return

    
    cleanup(editorInstance, viewZoneIds.current, decorationIds.current, widgetRef.current)
    viewZoneIds.current = []
    decorationIds.current = []
    widgetRef.current = null

    if (!entry) return

    const { parsed, path } = entry
    const { hunks, addCount, delCount } = parsed
    if (hunks.length === 0) return

    const fileName = path.split(/[/\\]/).pop() ?? path

    
    const zoneIds: string[] = []
    editorInstance.changeViewZones((accessor) => {
      for (const hunk of hunks) {
        if (hunk.oldLines.length === 0) continue
        const domNode = document.createElement('div')
        domNode.className = 'inline-diff-viewzone-deleted'
        for (const line of hunk.oldLines) {
          const lineEl = document.createElement('div')
          lineEl.className = 'inline-diff-deleted-line'
          lineEl.textContent = line || ' '
          domNode.appendChild(lineEl)
        }
        const id = accessor.addZone({
          afterLineNumber: Math.max(0, hunk.newLineAnchor - 1),
          heightInLines: hunk.oldLines.length,
          domNode,
          suppressMouseDown: true
        })
        zoneIds.push(id)
      }
    })
    viewZoneIds.current = zoneIds

    
    const decorations: editor.IModelDeltaDecoration[] = []
    for (const hunk of hunks) {
      if (hunk.newLines.length === 0) continue
      for (let i = 0; i < hunk.newLines.length; i++) {
        const lineNum = hunk.newStart + i
        decorations.push({
          range: {
            startLineNumber: lineNum,
            startColumn: 1,
            endLineNumber: lineNum,
            endColumn: 1
          },
          options: {
            isWholeLine: true,
            className: 'inline-diff-added-line-bg',
            glyphMarginClassName: 'inline-diff-added-glyph'
          }
        })
      }
    }
    decorationIds.current = editorInstance.deltaDecorations([], decorations)

    
    const firstHunk = hunks[0]
    const headerLine = Math.max(1, firstHunk.newLineAnchor - 1)
    const headerDom = document.createElement('div')
    headerDom.className = 'inline-diff-header'
    headerDom.innerHTML = `<span class="inline-diff-header-name">${escapeHtml(fileName)}</span>` +
      (addCount > 0 ? `<span class="inline-diff-header-stat add">+${addCount}</span>` : '') +
      (delCount > 0 ? `<span class="inline-diff-header-stat del">-${delCount}</span>` : '')
    const widget: editor.IContentWidget = {
      getId: () => 'inline-diff-header-widget',
      getDomNode: () => headerDom,
      getPosition: () => ({
        position: { lineNumber: headerLine, column: 1 },
        preference: [1] 
      })
    }
    editorInstance.addContentWidget(widget)
    widgetRef.current = widget

    return () => {
      cleanup(editorInstance, viewZoneIds.current, decorationIds.current, widgetRef.current)
      viewZoneIds.current = []
      decorationIds.current = []
      widgetRef.current = null
    }
  }, [editorInstance, entry])
}

function cleanup(
  editor: editor.IStandaloneCodeEditor,
  zoneIds: string[],
  decIds: string[],
  widget: editor.IContentWidget | null
): void {
  if (zoneIds.length > 0) {
    editor.changeViewZones((accessor) => {
      for (const id of zoneIds) accessor.removeZone(id)
    })
  }
  if (decIds.length > 0) {
    editor.deltaDecorations(decIds, [])
  }
  if (widget) {
    editor.removeContentWidget(widget)
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
