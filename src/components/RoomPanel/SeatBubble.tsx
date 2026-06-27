import { useState } from 'react'
import MarkdownView from '../AgentPanel/MarkdownView'
import Collapsible from '../AgentPanel/Collapsible'
import type { RoomMessageView } from '../../stores/roomStore'

// 单条群消息气泡。极简显示策略（§7.4）：默认只显示最终交付文本 + 一行过程摘要，
// 点「展开过程」才渲染工具活动/思考。用户消息靠右，岗位/系统靠左（仿微信）。
export default function SeatBubble({ msg }: { msg: RoomMessageView }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const isUser = msg.from === 'user'
  const isSystem = msg.from === 'system'
  const hasProcess = msg.activities.length > 0 || !!msg.thinking

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
          {hasProcess && (
            <div className="room-msg-process">
              <button type="button" className="room-process-toggle" onClick={() => setExpanded((v) => !v)}>
                {expanded ? '收起过程' : `展开过程（${msg.activities.length} 步${msg.thinking ? ' · 含思考' : ''}）`}
              </button>
              <Collapsible open={expanded}>
                {msg.thinking && <div className="room-process-thinking">{msg.thinking}</div>}
                <ul className="room-process-acts">
                  {msg.activities.map((a) => (
                    <li key={a.callId} className={`room-act room-act--${a.status}`}>
                      <span className="room-act-name">{a.name}</span>
                      {a.summary && <span className="room-act-sum">{a.summary}</span>}
                    </li>
                  ))}
                </ul>
              </Collapsible>
            </div>
          )}
          {msg.text
            ? <MarkdownView text={msg.text} streaming={msg.streaming} />
            : msg.streaming
              ? <span className="room-msg-typing">正在输入…</span>
              : null}
        </div>
      </div>
    </div>
  )
}
