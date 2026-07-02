import { useState } from 'react'
import MarkdownView from '../AgentPanel/MarkdownView'
import Collapsible from '../AgentPanel/Collapsible'
import ForcedRefsBadge from '../AgentPanel/ForcedRefsBadge'
import { stripForcedInstruction } from '../AgentPanel/slashCommand'
import type { RoomMessageView } from '../../stores/roomStore'

// 单条群消息气泡。极简显示策略（§7.4）：默认只显示最终交付文本 + 一行过程摘要，
// 点「展开过程」才渲染工具活动/思考。用户消息靠右，岗位/系统靠左（仿微信）。
function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

export default function SeatBubble({ msg, visibilityLabel }: { msg: RoomMessageView; visibilityLabel?: string }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const isUser = msg.from === 'user'
  const isSystem = msg.from === 'system'
  const hasProcess = msg.activities.length > 0 || !!msg.thinking
  // 仅用户消息可能含隐藏的强制指令，剥离后只显示正文 + 小徽标。
  const { body: displayText, forced } = isUser
    ? stripForcedInstruction(msg.text)
    : { body: msg.text, forced: [] }

  if (isSystem) {
    return (
      <div className="room-msg room-msg--system">
        <span className="room-system-text">{msg.text}</span>
      </div>
    )
  }

  return (
    <div className={`room-msg${isUser ? ' room-msg--user' : ' room-msg--seat'}`}>
      {!isUser && <div className="room-msg-avatar" title={msg.seatName}>{(msg.seatName ?? '?').slice(0, 2)}</div>}
      <div className="room-msg-body">
        {!isUser && <div className="room-msg-name">{msg.seatName}</div>}
        <div className="room-msg-bubble">
          {msg.visibility && msg.visibility.length > 0 && (
            <div className="room-msg-private" title="私密消息：仅特定成员可见，不在公屏显示">{visibilityLabel ?? '🔒 私信'}</div>
          )}
          {hasProcess && (
            <div className="room-msg-process">
              <button type="button" className="room-process-toggle" onClick={() => setExpanded((v) => !v)}>
                {expanded ? '收起过程' : `展开过程（${msg.activities.length} 步${msg.thinking ? ' · 含思考' : ''}）`}
              </button>
              <Collapsible open={expanded}>
                {msg.thinking && <div className="room-process-thinking">{msg.thinking}</div>}
                <ul className="room-process-acts">
                  {msg.activities.map((a) => (
                    <li
                      key={a.callId}
                      className={`room-act room-act--${a.status}`}
                      title={a.argsText ? `${a.name}\n\n${a.argsText}` : a.name}
                    >
                      <span className="room-act-name">{a.name}</span>
                      {a.summary && <span className="room-act-sum">{a.summary}</span>}
                    </li>
                  ))}
                </ul>
              </Collapsible>
            </div>
          )}
          {msg.text
            ? <MarkdownView text={displayText} streaming={msg.streaming} />
            : msg.streaming
              ? <span className="room-msg-typing">正在输入…</span>
              : null}
          {forced.length > 0 && <ForcedRefsBadge refs={forced} />}
        </div>
        {isUser && <div className="room-msg-time">{formatTime(msg.ts)}</div>}
      </div>
    </div>
  )
}
