import { useMemo, useState } from 'react'
import type { ChatMessageView, SubagentTabView } from '@/stores/agentStore'
import { useAgentStore } from '@/stores/agentStore'
import { buildMessageSegments, type MessageSegment } from './turnLayout'
import ThinkingBlock from './ThinkingBlock'
import ActivitySummary from './ActivitySummary'
import CommandCard from './CommandCard'
import DiffPreview from './DiffPreview'
import MarkdownView from './MarkdownView'
import { normalizeAssistantMessage, isAssistantVisible } from './assistantContent'
import Collapsible from './Collapsible'

function statusText(status: SubagentTabView['status']): string {
  if (status === 'running') return '运行中'
  if (status === 'error') return '失败'
  return '已完成'
}

function subagentTypeLabel(tab: SubagentTabView): string {
  if (tab.subagentType) return tab.subagentType
  return tab.readOnly === false ? '可写' : '只读'
}

function formatDuration(ms: number | undefined): string | null {
  if (typeof ms !== 'number') return null
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function AssistantPart({ msg }: { msg: ChatMessageView }): JSX.Element | null {
  const { body, thinking } = normalizeAssistantMessage(msg.content, msg.thinking, msg.streaming)
  if (!isAssistantVisible(msg.content, msg.thinking, msg.streaming)) return null

  const hasBody = body.trim().length > 0
  const thinkingActive = !!msg.streaming && !hasBody

  return (
    <div className="agent-assistant-part">
      {thinking.length > 0 || thinkingActive ? <ThinkingBlock id={msg.id} text={thinking} active={thinkingActive} /> : null}
      {hasBody ? (
        <div className="agent-assistant-text">
          <MarkdownView text={body} streaming={msg.streaming} />
        </div>
      ) : null}
    </div>
  )
}

function AssistantGroup({ messages }: { messages: ChatMessageView[] }): JSX.Element | null {
  const visible = messages.filter((m) => isAssistantVisible(m.content, m.thinking, m.streaming))
  if (visible.length === 0) return null

  return (
    <div className="agent-msg assistant">
      <div className="agent-msg-body agent-assistant-group">
        {visible.map((m) => (
          <AssistantPart key={m.id} msg={m} />
        ))}
      </div>
    </div>
  )
}

function PromptBubble({ msg }: { msg: ChatMessageView }): JSX.Element {
  return (
    <div className="subagent-prompt-card">
      <div className="subagent-prompt-card-label">主 Agent 发给子 Agent 的任务</div>
      <div className="subagent-prompt-card-text">{msg.content}</div>
    </div>
  )
}

function ErrorBlock({ msg }: { msg: ChatMessageView }): JSX.Element {
  return (
    <div className="agent-msg error">
      <div className="agent-msg-body error">{msg.content}</div>
    </div>
  )
}

function ChangeStack({ files }: { files: ChatMessageView[] }): JSX.Element {
  const batchMode = files.length > 1
  return (
    <div className="agent-change-stack">
      {files.map((f) => (
        <DiffPreview key={f.id} msg={f} batchMode={batchMode} />
      ))}
    </div>
  )
}

function SubagentTurn({ segments }: { segments: MessageSegment[] }): JSX.Element {
  return (
    <div className="agent-turn subagent-flow-turn">
      {segments.map((seg, i) => {
        switch (seg.kind) {
          case 'user':
            return <PromptBubble key={seg.message.id} msg={seg.message} />
          case 'assistant_group':
            return <AssistantGroup key={`asg-${i}`} messages={seg.messages} />
          case 'activity':
            return <ActivitySummary key={`act-${i}`} tools={seg.tools} />
          case 'command':
            return <CommandCard key={seg.message.id} msg={seg.message} />
          case 'changes':
            return <ChangeStack key={`chg-${i}`} files={seg.files} />
          case 'error':
            return <ErrorBlock key={seg.message.id} msg={seg.message} />
          default:
            return null
        }
      })}
    </div>
  )
}

export default function SubagentRunView({ tab }: { tab: SubagentTabView }): JSX.Element {
  const segments = useMemo(() => buildMessageSegments(tab.messages), [tab.messages])
  const duration = formatDuration(tab.durationMs)
  const [expanded, setExpanded] = useState(tab.status === 'running')
  const detailId = `subagent-run-detail-${tab.id}`
  const streaming = useAgentStore((s) => s.streaming)
  const handBack = useAgentStore((s) => s.handBackSubagent)
  
  const canHandBack = tab.background && tab.status !== 'running' && !tab.handedBack

  return (
    <div className={`subagent-run-view ${expanded ? 'expanded' : 'collapsed'}`}>
      <button
        type="button"
        className="subagent-run-card"
        aria-expanded={expanded}
        aria-controls={detailId}
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="subagent-run-header compact">
          <div>
            <div className="subagent-run-kicker">
              <span className="subagent-run-badge">子 Agent</span>
              <span>{subagentTypeLabel(tab)}</span>
              {tab.model ? <span className="subagent-run-model" title={`模型：${tab.model}`}>{tab.model}</span> : null}
              {duration ? <span className="subagent-run-elapsed">{duration}</span> : null}
            </div>
            <h3>{tab.title}</h3>
          </div>
          <span className={`subagent-run-status ${tab.status}`}>{statusText(tab.status)}</span>
        </div>

        {tab.failureSummary ? (
          <div className="subagent-run-metrics" aria-label="子 Agent 执行统计">
            <span className="error">失败摘要：{tab.failureSummary}</span>
          </div>
        ) : null}
      </button>

      {canHandBack ? (
        <div className="subagent-handback" role="status">
          <span className="subagent-handback-text">
            {tab.status === 'error' ? '后台子 Agent 已结束（有错误）' : '后台子 Agent 已完成'}
          </span>
          <button
            type="button"
            className="subagent-handback-btn"
            disabled={streaming}
            onClick={() => handBack(tab.id)}
          >
            让 Agent 处理结果
          </button>
        </div>
      ) : null}

      <Collapsible open={expanded}>
        <div id={detailId} className="subagent-flow" aria-label="子 Agent 执行流程">
          <SubagentTurn segments={segments} />
        </div>
      </Collapsible>
    </div>
  )
}
