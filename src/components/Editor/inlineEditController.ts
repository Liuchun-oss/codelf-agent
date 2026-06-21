import type { editor } from 'monaco-editor'
import { getEditorInstance } from './editorBridge'
import { useInlineEditStore } from '@/stores/inlineEditStore'
import { useInlineDiffStore } from '@/stores/inlineDiffStore'
import { useEditorStore } from '@/stores/editorStore'

interface PendingSelection {
  path: string
  
  startLine: number
  endLine: number
  
  selectionText: string
}

let pending: PendingSelection | null = null

export function getPendingSelection(): PendingSelection | null {
  return pending
}

/** Called when the user presses Ctrl+K in the editor. Captures selection and opens the widget. */
export function triggerInlineEdit(ed: editor.IStandaloneCodeEditor): void {
  const model = ed.getModel()
  if (!model) return
  const path = useEditorStore.getState().activeTabPath
  if (!path) return

  
  if (useInlineDiffStore.getState().getEntry(path)) return
  
  if (useInlineEditStore.getState().active) return

  const sel = ed.getSelection()
  if (!sel) return

  
  const startLine = sel.startLineNumber
  
  let endLine = sel.endLineNumber
  if (endLine > startLine && sel.endColumn === 1) endLine -= 1
  

  const fullStart = { lineNumber: startLine, column: 1 }
  const lineEndCol = model.getLineMaxColumn(endLine)
  const range = {
    startLineNumber: startLine,
    startColumn: 1,
    endLineNumber: endLine,
    endColumn: lineEndCol
  }
  const selectionText = model.getValueInRange(range)

  pending = { path, startLine, endLine, selectionText }

  
  const visible = ed.getScrolledVisiblePosition(fullStart)
  const dom = ed.getDomNode()
  let top = 80
  let left = 200
  let width = 480
  if (visible && dom) {
    const rect = dom.getBoundingClientRect()
    top = rect.top + visible.top
    left = rect.left + 60
    width = Math.min(560, Math.max(360, rect.width - 120))
  }

  useInlineEditStore.getState().open(path, { top, left, width, anchorLine: startLine })
}

/** Trigger an AI fix for diagnostics on a given range (from the lightbulb code action). */
export function triggerAiFix(
  ed: editor.IStandaloneCodeEditor,
  range: { startLineNumber: number; endLineNumber: number },
  messages: string[]
): void {
  const model = ed.getModel()
  if (!model) return
  const path = useEditorStore.getState().activeTabPath
  if (!path) return
  if (useInlineDiffStore.getState().getEntry(path)) return
  if (useInlineEditStore.getState().active) return

  const startLine = Math.max(1, range.startLineNumber)
  const endLine = Math.min(model.getLineCount(), range.endLineNumber)
  const selRange = {
    startLineNumber: startLine,
    startColumn: 1,
    endLineNumber: endLine,
    endColumn: model.getLineMaxColumn(endLine)
  }
  const selectionText = model.getValueInRange(selRange)
  pending = { path, startLine, endLine, selectionText }

  const visible = ed.getScrolledVisiblePosition({ lineNumber: startLine, column: 1 })
  const dom = ed.getDomNode()
  let top = 80
  let left = 200
  let width = 480
  if (visible && dom) {
    const rect = dom.getBoundingClientRect()
    top = rect.top + visible.top
    left = rect.left + 60
    width = Math.min(560, Math.max(360, rect.width - 120))
  }

  const instruction =
    '修复以下诊断问题，保持其余代码不变：\n' + messages.map((m) => `- ${m}`).join('\n')

  const store = useInlineEditStore.getState()
  store.open(path, { top, left, width, anchorLine: startLine })
  store.setInstruction(instruction)
  void runInlineEdit(instruction)
}

/** Re-base AI output to the original selection's leading indentation, preserving relative indent. */
function reindentReplacement(selection: string, replacement: string): string {
  const selFirst = selection.split(/\r?\n/)[0] ?? ''
  const baseIndent = /^[ \t]*/.exec(selFirst)?.[0] ?? ''
  const resLines = replacement.split('\n')

  let min: string | null = null
  for (const l of resLines) {
    if (l.trim() === '') continue
    const ind = /^[ \t]*/.exec(l)?.[0] ?? ''
    if (min === null || ind.length < min.length) min = ind
  }
  const strip = min ?? ''

  return resLines
    .map((l) => {
      if (l.trim() === '') return ''
      const body = l.startsWith(strip) ? l.slice(strip.length) : l.replace(/^[ \t]*/, '')
      return baseIndent + body
    })
    .join('\n')
}

/** Build a full-file unified-style diff (context + selection replacement) the existing parser understands. */
function buildFullFileDiff(
  fullText: string,
  startLine: number,
  endLine: number,
  replacement: string
): string {
  
  const lines = fullText.split(/\r?\n/)
  const before = lines.slice(0, startLine - 1)
  const oldSel = lines.slice(startLine - 1, endLine)
  const after = lines.slice(endLine)
  const newSel = replacement.replace(/\r\n/g, '\n').split('\n')

  const out: string[] = []
  for (const l of before) out.push(' ' + l)
  for (const l of oldSel) out.push('-' + l)
  for (const l of newSel) out.push('+' + l)
  for (const l of after) out.push(' ' + l)
  return out.join('\n')
}

/** Submit the instruction to the AI and, on success, show an inline diff. */
export async function runInlineEdit(instruction: string): Promise<void> {
  const p = pending
  const ed = getEditorInstance()
  if (!p || !ed) return
  const model = ed.getModel()
  if (!model) return
  
  if (useEditorStore.getState().activeTabPath !== p.path) return

  const store = useInlineEditStore.getState()
  store.setStatus('loading')

  const fullText = model.getValue()
  const eol = model.getEOL()
  const offsetStart = model.getOffsetAt({ lineNumber: p.startLine, column: 1 })
  const offsetEnd = model.getOffsetAt({
    lineNumber: p.endLine,
    column: model.getLineMaxColumn(p.endLine)
  })
  const prefix = fullText.slice(0, offsetStart)
  const suffix = fullText.slice(offsetEnd)

  const tab = useEditorStore.getState().tabs.find((t) => t.path === p.path)

  const res = await window.lc.aiInlineEdit({
    instruction,
    selection: p.selectionText,
    language: tab?.language ?? 'plaintext',
    filePath: p.path,
    prefix,
    suffix
  })

  
  if (!useInlineEditStore.getState().active) return
  
  if (useEditorStore.getState().activeTabPath !== p.path) {
    useInlineEditStore.getState().close()
    return
  }

  if (!res.ok || res.text == null) {
    useInlineEditStore.getState().setError(res.error ?? '生成失败')
    return
  }

  
  const reindented = reindentReplacement(p.selectionText, res.text)
  const replacement = reindented.replace(/\r\n/g, '\n').replace(/\n/g, eol)
  const rawDiff = buildFullFileDiff(fullText, p.startLine, p.endLine, reindented)
  const newContent = fullText.slice(0, offsetStart) + replacement + fullText.slice(offsetEnd)
  useInlineDiffStore.getState().proposeDiff(p.path, rawDiff, fullText, newContent)

  useInlineEditStore.getState().setStatus('diff')
}

export function acceptInlineEdit(): void {
  const p = pending
  if (!p) {
    useInlineEditStore.getState().close()
    return
  }
  useInlineDiffStore.getState().acceptDiff(p.path)
  pending = null
  useInlineEditStore.getState().close()
}

export function rejectInlineEdit(): void {
  const p = pending
  void window.lc.aiInlineEditCancel()
  if (p) useInlineDiffStore.getState().clearDiff(p.path)
  pending = null
  useInlineEditStore.getState().close()
}
