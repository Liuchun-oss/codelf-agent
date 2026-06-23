import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { ChatMessageView } from '@/stores/agentStore'
import { useAgentStore } from '@/stores/agentStore'
import DiffPreview from '@/components/AgentPanel/DiffPreview'
import PermissionPrompt from '@/components/AgentPanel/PermissionPrompt'
import UserQuestionPrompt from '@/components/AgentPanel/UserQuestionPrompt'
import UserMessageBubble from '@/components/AgentPanel/UserMessageBubble'
import ActivitySummary from '@/components/AgentPanel/ActivitySummary'
import CommandCard from '@/components/AgentPanel/CommandCard'
import ChangeBatchBar from '@/components/AgentPanel/ChangeBatchBar'
import LazyRow from '@/components/AgentPanel/LazyRow'
import SubagentRunView from './SubagentRunView'
import TaskListPanel from './TaskListPanel'
import { buildMessageSegments, findLastUserMessage, type MessageSegment } from './turnLayout'
import { useAgentChatScroll } from './useAgentChatScroll'
import ThinkingBlock from './ThinkingBlock'
import MarkdownView from './MarkdownView'
import { normalizeAssistantMessage, isAssistantVisible } from './assistantContent'


const VIRTUALIZE_THRESHOLD = 40

function AssistantPart({
  msg,
  onTypingDone
}: {
  msg: ChatMessageView
  onTypingDone?: (done: boolean) => void
}): JSX.Element | null {
  const { body, thinking } = normalizeAssistantMessage(msg.content, msg.thinking)
  const visible = isAssistantVisible(msg.content, msg.thinking, msg.streaming)

  const hasBody = body.trim().length > 0
  const thinkingActive = !!msg.streaming && !hasBody
  // 仅在流式且最终图尚未写入正文（content 不含 codelf-artifact 图片）时显示中间预览，
  // 避免最终图落盘后与正文里的 markdown 图重复。
  const partialPreviews =
    msg.streaming && msg.partialImages && !/!\[[^\]]*\]\(codelf-artifact:/.test(msg.content)
      ? Object.entries(msg.partialImages).sort((a, b) => Number(a[0]) - Number(b[0]))
      : []

  useEffect(() => {
    if (!hasBody) onTypingDone?.(true)
  }, [hasBody, onTypingDone])

  if (!visible) return null

  return (
    <div className="agent-assistant-part">
      {thinking.length > 0 || thinkingActive ? (
        <ThinkingBlock text={thinking} active={thinkingActive} />
      ) : null}
      {hasBody ? (
        <div className="agent-assistant-text">
          <MarkdownView text={body} streaming={msg.streaming} onTypingDone={onTypingDone} />
        </div>
      ) : null}
      {partialPreviews.length > 0 ? (
        <div className="agent-generated-image-preview">
          {partialPreviews.map(([idx, src]) => (
            <img key={idx} src={src} alt="生成中…" className="cm-md-img" />
          ))}
          <span className="agent-generated-image-hint">图片生成中…</span>
        </div>
      ) : null}
      {msg.stopped ? <div className="agent-stopped">已停止</div> : null}
    </div>
  )
}

function AssistantGroup({
  messages,
  onTypingDone
}: {
  messages: ChatMessageView[]
  onTypingDone?: (done: boolean) => void
}): JSX.Element | null {
  const visible = messages.filter((m) => isAssistantVisible(m.content, m.thinking, m.streaming))
  const doneMapRef = useRef<Record<string, boolean>>({})
  const lastReportedRef = useRef<boolean | null>(null)

  const report = useCallback(
    (id: string, done: boolean) => {
      doneMapRef.current[id] = done
      const all = messages.every((m) => doneMapRef.current[m.id] === true)
      if (lastReportedRef.current !== all) {
        lastReportedRef.current = all
        onTypingDone?.(all)
      }
    },
    [messages, onTypingDone]
  )

  if (visible.length === 0) {
    return (
      <>
        {messages.map((m) => (
          <DoneReporter key={m.id} id={m.id} onDone={report} />
        ))}
      </>
    )
  }

  return (
    <div className="agent-msg assistant">
      <div className="agent-msg-body agent-assistant-group">
        {messages.map((m) =>
          isAssistantVisible(m.content, m.thinking, m.streaming) ? (
            <AssistantPart key={m.id} msg={m} onTypingDone={(done) => report(m.id, done)} />
          ) : (
            <DoneReporter key={m.id} id={m.id} onDone={report} />
          )
        )}
      </div>
    </div>
  )
}

function DoneReporter({
  id,
  onDone
}: {
  id: string
  onDone: (id: string, done: boolean) => void
}): null {
  useEffect(() => {
    onDone(id, true)
  }, [id, onDone])
  return null
}

function ErrorBlock({ msg }: { msg: ChatMessageView }): JSX.Element {
  const retry = useAgentStore((s) => s.retry)
  const streaming = useAgentStore((s) => s.streaming)
  return (
    <div className="agent-msg error">
      <div className="agent-msg-body error">
        {msg.content}
        <button
          type="button"
          className="agent-retry-btn"
          disabled={streaming}
          title={streaming ? '生成中，无法重试' : '重新发送上一条消息'}
          onClick={retry}
        >
          重试
        </button>
      </div>
    </div>
  )
}

function ChangeStack({
  files,
  reviewExpanded
}: {
  files: ChatMessageView[]
  reviewExpanded: boolean
}): JSX.Element {
  const batchMode = files.length > 1
  return (
    <div className="agent-change-stack">
      {files.map((f, idx) => (
        <DiffPreview
          key={`${f.id}__${idx}`}
          msg={f}
          forceExpanded={reviewExpanded}
          batchMode={batchMode}
        />
      ))}
    </div>
  )
}

function TaskListPanelSegment(): JSX.Element | null {
  const tasks = useAgentStore((s) => s.tasks)
  if (tasks.length === 0) return null
  return <TaskListPanel tasks={tasks} />
}

function isLiveSegment(seg: MessageSegment): boolean {
  
  
  if (seg.kind === 'changes') return seg.files.some((f) => f.fileStatus === 'streaming')
  if (seg.kind === 'command') return seg.message.toolStatus === 'running'
  return false
}

function TurnBlock({ segments }: { segments: MessageSegment[] }): JSX.Element {
  const [reviewId, setReviewId] = useState<string | null>(null)
  // 历史内容（组内无流式消息）首帧即视为“打字完成”。否则挂载时 doneGroups
  // 为空，blockFrom 会把第一个助手组之后的段落全部隐藏，等 onTypingDone 经
  // useEffect 在绘制后逐层上报、逐帧披露——切换会话时总高度跨多帧逐步长高，
  // 贴底逻辑跟着追，看起来就是“从中间滚下来”而不是直接定格底部。
  const [doneGroups, setDoneGroups] = useState<Record<number, boolean>>(() => {
    const init: Record<number, boolean> = {}
    segments.forEach((seg, i) => {
      if (seg.kind === 'assistant_group' && seg.messages.every((m) => !m.streaming)) {
        init[i] = true
      }
    })
    return init
  })

  const setGroupDone = useCallback((idx: number, done: boolean) => {
    setDoneGroups((prev) => (prev[idx] === done ? prev : { ...prev, [idx]: done }))
  }, [])

  
  
  let blockFrom = segments.length
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].kind === 'assistant_group' && doneGroups[i] !== true) {
      blockFrom = i + 1
      break
    }
  }

  return (
    <div className="agent-turn">
      {segments.map((seg, i) => {
        
        
        if (i >= blockFrom && !isLiveSegment(seg)) return null
        switch (seg.kind) {
          case 'assistant_group':
            return (
              <AssistantGroup
                key={`asg-${i}`}
                messages={seg.messages}
                onTypingDone={(done) => setGroupDone(i, done)}
              />
            )
          case 'activity':
            return <ActivitySummary key={`act-${i}`} tools={seg.tools} />
          case 'command':
            return <CommandCard key={seg.message.id} msg={seg.message} />
          case 'changes': {
            const batchKey = `chg-${i}-${seg.files[0]?.turnId ?? seg.files[0]?.id ?? ''}`
            const expanded = reviewId === batchKey
            return (
              <div key={`chg-${i}`} className="agent-change-group">
                <ChangeStack files={seg.files} reviewExpanded={expanded} />
                <ChangeBatchBar
                  files={seg.files}
                  reviewExpanded={expanded}
                  onToggleReview={() => setReviewId(expanded ? null : batchKey)}
                />
              </div>
            )
          }
          case 'permission':
            return <PermissionPrompt key={seg.message.id} msg={seg.message} />
          case 'question':
            return <UserQuestionPrompt key={seg.message.id} msg={seg.message} />
          case 'error':
            return <ErrorBlock key={seg.message.id} msg={seg.message} />
          case 'notice':
            return (
              <div key={seg.message.id} className="agent-notice" role="status">
                {seg.message.content}
              </div>
            )
          case 'subagent':
            return seg.message.subagent ? (
              <SubagentRunView key={seg.message.id} tab={seg.message.subagent} />
            ) : null
          case 'tasklist':
            return <TaskListPanelSegment key={`tasklist-${i}`} />
          default:
            return null
        }
      })}
    </div>
  )
}


function buildTurnRows(
  segments: MessageSegment[],
  opts: {
    scrollRef: RefObject<HTMLDivElement | null>
    virtualize: boolean
  }
): JSX.Element[] {
  const rows: JSX.Element[] = []
  let turnSegs: MessageSegment[] = []

  const flushTurn = (): void => {
    if (turnSegs.length === 0) return
    rows.push(
      <TurnBlock key={`turn-${rows.length}`} segments={[...turnSegs]} />
    )
    turnSegs = []
  }

  for (const seg of segments) {
    if (seg.kind === 'user') {
      flushTurn()
      rows.push(
        <UserMessageBubble
          key={seg.message.id}
          msg={seg.message}
        />
      )
    } else {
      turnSegs.push(seg)
    }
  }
  flushTurn()

  if (!opts.virtualize) return rows

  // 始终用同一个 LazyRow 包裹每一行，key 恒为 `lazy-<行 key>`，靠 forceMounted
  // 切换是否常驻。绝不能让某一行在“裸渲染 ↔ LazyRow 包裹”之间切换：那会改变
  // 元素标识触发重挂载，LazyRow 重挂载初始 visible=true 会以完整高度先撑开、再被
  // IntersectionObserver 异步折叠，造成视口上方内容位移、画面突然向上跳。
  const keepMountedFrom = Math.max(0, rows.length - 2)
  return rows.map((row, i) => (
    <LazyRow
      key={`lazy-${row.key ?? i}`}
      scrollRef={opts.scrollRef}
      forceMounted={i >= keepMountedFrom}
    >
      {row}
    </LazyRow>
  ))
}

interface MessageListProps {
  scrollContainerRef: RefObject<HTMLDivElement | null>
}

export default function MessageList({ scrollContainerRef }: MessageListProps): JSX.Element {
  const messages = useAgentStore((s) => s.messages)
  const currentSessionId = useAgentStore((s) => s.currentSessionId)
  const lastUser = useMemo(() => findLastUserMessage(messages), [messages])
  const endRef = useRef<HTMLDivElement>(null)
  const segments = useMemo(() => buildMessageSegments(messages), [messages])
  const virtualize = messages.length > VIRTUALIZE_THRESHOLD
  const rows = useMemo(
    () =>
      buildTurnRows(segments, {
        scrollRef: scrollContainerRef,
        virtualize
      }),
    [segments, scrollContainerRef, virtualize]
  )

  useAgentChatScroll(scrollContainerRef, endRef, lastUser?.id, messages, currentSessionId)

  return (
    <div className="agent-messages">
      {rows}
      <div ref={endRef} className="agent-messages-end" aria-hidden />
    </div>
  )
}
