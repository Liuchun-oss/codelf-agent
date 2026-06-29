import { useEffect, useState } from 'react'
import type { ChatMessageView } from '@/stores/agentStore'
import Collapsible from './Collapsible'



const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

function cleanOutput(raw: string | undefined): string {
  if (!raw) return ''
  return raw.replace(ANSI_RE, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

type OutputLineKind = 'cmd' | 'meta' | 'out'

function classifyOutputLine(line: string): OutputLineKind {
  if (line.startsWith('$ ')) return 'cmd'
  if (/^(exit code:|stdout:|stderr:)/.test(line)) return 'meta'
  if (line.startsWith('(') && line.endsWith(')')) return 'meta'
  return 'out'
}

function commandLabel(msg: ChatMessageView): string {
  const args = msg.toolArgs ?? {}
  const command = typeof args.command === 'string' ? args.command.trim() : ''
  if (command) return command
  const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : ''
  switch (msg.toolName) {
    case 'ReadTerminalTask':
      return taskId ? `读取后台任务 ${taskId}` : '读取后台任务'
    case 'StopTerminalTask':
      return taskId ? `停止后台任务 ${taskId}` : '停止后台任务'
    case 'WriteTerminalTask': {
      const text = typeof args.input === 'string' ? args.input : ''
      return text ? `输入 ${JSON.stringify(text)} → 后台任务${taskId ? ` ${taskId}` : ''}` : '写入后台任务输入'
    }
    default:
      return '终端命令'
  }
}


export default function CommandCard({ msg }: { msg: ChatMessageView }): JSX.Element {
  const command = commandLabel(msg)
  const status = msg.toolStatus ?? 'done'
  const running = status === 'running'
  const error = status === 'error'
  const liveOutput = cleanOutput(msg.toolStream)
  const finalOutput = cleanOutput(msg.toolResult)
  const output = running && liveOutput ? liveOutput : finalOutput || liveOutput

  const [open, setOpen] = useState(running || error)

  useEffect(() => {
    if (status !== 'done') return
    const timer = setTimeout(() => setOpen(false), 2000)
    return () => clearTimeout(timer)
  }, [status])

  return (
    <div className={`agent-cmd-card ${status}`}>
      <button
        type="button"
        className="agent-cmd-head"
        onClick={() => setOpen((v) => !v)}
        title={command}
      >
        <span className="agent-cmd-prompt" aria-hidden>
          $
        </span>
        <span className="agent-cmd-text">{command || '终端命令'}</span>
        <span className="agent-cmd-status" aria-hidden>
          {running ? (
            <span className="agent-cmd-spinner" />
          ) : error ? (
            <span className="agent-cmd-badge err">✕</span>
          ) : (
            <span className="agent-cmd-badge ok">✓</span>
          )}
        </span>
        <span className="agent-cmd-chevron" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
      </button>
      <Collapsible open={open}>
        {output ? (
          <pre className="agent-cmd-output">
            {output.split('\n').map((line, i) => (
              <span key={i} className={`agent-cmd-line ${classifyOutputLine(line)}`}>
                {line || ' '}
              </span>
            ))}
          </pre>
        ) : (
          <div className="agent-cmd-empty">{running ? '运行中…' : '（无输出）'}</div>
        )}
        {msg.toolTruncated && <div className="agent-cmd-truncated">输出已截断</div>}
      </Collapsible>
    </div>
  )
}
