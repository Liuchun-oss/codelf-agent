import { useEffect, useRef, useState } from 'react'
import type { ChatMessageView } from '@/stores/agentStore'
import { useAgentStore } from '@/stores/agentStore'
import { useEditorStore } from '@/stores/editorStore'
import FileIcon from '@/components/common/FileIcon'
import Collapsible from './Collapsible'

function countDiffStats(diff: string): { add: number; del: number } {
  let add = 0
  let del = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) continue
    if (line.startsWith('+')) add++
    else if (line.startsWith('-')) del++
  }
  return { add, del }
}

function findFirstChangeLine(diff: string): number {
  const lines = diff.split('\n')
  let newLineNo = 1
  for (const line of lines) {
    if (line.startsWith('@@')) {
      const omitted = line.match(/省略 (\d+) 行未改动/)
      if (omitted) newLineNo += Number(omitted[1])
      continue
    }
    if (line.startsWith('+')) return newLineNo
    if (line.startsWith('-')) return newLineNo
    newLineNo++
  }
  return 1
}

const COLLAPSED_CONTEXT_BEFORE = 4
const COLLAPSED_CONTEXT_AFTER = 7

function isChangedLine(line: string): boolean {
  return line.startsWith('+') || line.startsWith('-')
}

function getFocusedDiffLines(diff: string, expanded: boolean): { lines: string[]; start: number } {
  const lines = diff.split('\n')
  if (expanded) return { lines, start: 0 }

  const firstChange = lines.findIndex(isChangedLine)
  if (firstChange === -1) {
    return { lines: lines.slice(0, 12), start: 0 }
  }

  let lastChange = firstChange
  for (let i = lines.length - 1; i > firstChange; i--) {
    if (isChangedLine(lines[i])) {
      lastChange = i
      break
    }
  }

  const start = Math.max(0, firstChange - COLLAPSED_CONTEXT_BEFORE)
  const end = Math.min(lines.length, lastChange + COLLAPSED_CONTEXT_AFTER + 1)
  return { lines: lines.slice(start, end), start }
}

function DiffSnippet({ diff }: { diff: string }): JSX.Element {
  const { lines, start } = getFocusedDiffLines(diff, true)

  return (
    <pre className="agent-diff-card-body">
      {lines.map((line, i) => {
        const isHunk = line.startsWith('@@')
        const cls = isHunk
          ? 'hunk'
          : line.startsWith('+')
            ? 'add'
            : line.startsWith('-')
              ? 'del'
              : 'ctx'
        const displayLine = line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')
          ? line.slice(1)
          : line
        return (
          <div key={start + i} className={`agent-diff-line ${cls}`}>
            {displayLine || ' '}
          </div>
        )
      })}
    </pre>
  )
}

interface Props {
  msg: ChatMessageView
  
  forceExpanded?: boolean
  
  batchMode?: boolean
}


export default function DiffPreview({ msg, forceExpanded, batchMode }: Props): JSX.Element {
  const status = msg.fileStatus ?? 'proposed'
  const [open, setOpen] = useState(status === 'proposed' || status === 'streaming')
  const [autoSec, setAutoSec] = useState<number | null>(null)
  const prevResolvedRef = useRef(status === 'applied' || status === 'rejected')
  const respond = useAgentStore((s) => s.respondFileChange)
  const revertFileChange = useAgentStore((s) => s.revertFileChange)
  const redoFileChange = useAgentStore((s) => s.redoFileChange)
  const permissionMode = useAgentStore((s) => s.permissionMode)
  const openFileAt = useEditorStore((s) => s.openFileAt)
  const streaming = status === 'streaming'
  const pending = status === 'proposed'
  const applied = status === 'applied'
  const reverted = status === 'reverted'
  const acceptEdits = permissionMode === 'acceptEdits'
  const expanded = forceExpanded || open

  useEffect(() => {
    const resolved = status === 'applied' || status === 'rejected'
    if (resolved && !prevResolvedRef.current) setOpen(false)
    prevResolvedRef.current = resolved
  }, [status])

  const fileName = msg.filePath?.split(/[/\\]/).pop() || (streaming ? '准备写入文件…' : 'file')
  const stats = msg.fileDiff ? countDiffStats(msg.fileDiff) : { add: 0, del: 0 }
  const canOpenFile = !!msg.filePath && !streaming

  const openAtChange = (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (!canOpenFile || !msg.filePath) return
    const line = msg.fileDiff ? findFirstChangeLine(msg.fileDiff) : 1
    void openFileAt(msg.filePath, fileName, line, 1)
  }

  useEffect(() => {
    if (!pending || !acceptEdits) return
    let cancelled = false
    let timer: ReturnType<typeof setInterval> | undefined
    void window.lc.aiGetAgentSettings().then((s) => {
      if (cancelled) return
      const ms = s.acceptEditsAutoApplyDelayMs
      if (ms <= 0) return
      const end = Date.now() + ms
      const tick = (): void => {
        setAutoSec(Math.max(0, Math.ceil((end - Date.now()) / 1000)))
      }
      tick()
      timer = setInterval(tick, 200)
    })
    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
  }, [pending, acceptEdits, msg.id])

  return (
    <div className={`agent-diff-card ${status}${applied || reverted ? ' compact' : ''}`}>
      <button
        type="button"
        className="agent-diff-card-head"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="agent-diff-card-icon">
          <FileIcon name={fileName} />
        </span>
        <span
          className="agent-diff-card-name agent-diff-card-name-link"
          role="link"
          tabIndex={canOpenFile ? 0 : -1}
          title={canOpenFile ? `打开 ${fileName} 并跳转到首个改动` : fileName}
          onClick={openAtChange}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') openAtChange(e as unknown as React.MouseEvent)
          }}
        >
          {fileName}
        </span>
        <span className="agent-diff-card-spacer" aria-hidden />
        {streaming && <span className="agent-diff-card-writing">写入中</span>}
        {!streaming && stats.add > 0 && (
          <span className="agent-diff-card-stat add">+{stats.add}</span>
        )}
        {!streaming && stats.del > 0 && (
          <span className="agent-diff-card-stat del">-{stats.del}</span>
        )}
        {applied && msg.fileRevertable && (
          <span
            role="button"
            tabIndex={0}
            className="agent-diff-card-action-inline danger"
            title="撤销该文件的本次变更"
            onClick={(e) => {
              e.stopPropagation()
              void revertFileChange(msg.id)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation()
                void revertFileChange(msg.id)
              }
            }}
          >
            撤销
          </span>
        )}
        {reverted && (
          <>
            <span className="agent-diff-card-reverted-tag">已撤销</span>
            {msg.fileRevertable && (
              <span
                role="button"
                tabIndex={0}
                className="agent-diff-card-action-inline"
                title="重新应用该文件的变更"
                onClick={(e) => {
                  e.stopPropagation()
                  void redoFileChange(msg.id)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.stopPropagation()
                    void redoFileChange(msg.id)
                  }
                }}
              >
                取消撤销
              </span>
            )}
          </>
        )}
        <span className="agent-diff-card-chevron">{expanded ? '▾' : '▸'}</span>
      </button>
      <Collapsible open={expanded && (streaming || !!msg.fileDiff)}>
        {streaming ? (
          <div className="agent-diff-card-pending">正在写入中，请稍后…</div>
        ) : msg.fileDiff ? (
          <DiffSnippet diff={msg.fileDiff} />
        ) : null}
      </Collapsible>
      {pending && !batchMode && (
        <div className="agent-diff-card-actions">
          {acceptEdits ? (
            <>
              {autoSec != null && autoSec > 0 && (
                <span className="agent-filechange-auto-hint">{autoSec}s 后自动应用</span>
              )}
              <button
                type="button"
                className="btn-secondary danger"
                onClick={() => respond(msg.id, 'reject')}
              >
                撤销
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn" onClick={() => respond(msg.id, 'accept')}>
                接受
              </button>
              <button
                type="button"
                className="btn-secondary danger"
                onClick={() => respond(msg.id, 'reject')}
              >
                拒绝
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
