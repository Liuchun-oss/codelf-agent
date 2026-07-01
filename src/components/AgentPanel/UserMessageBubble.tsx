import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChatMessageView } from '@/stores/agentStore'
import { useAgentStore } from '@/stores/agentStore'
import { stripForcedInstruction } from './slashCommand'
import ForcedRefsBadge from './ForcedRefsBadge'
import ImageLightbox from './ImageLightbox'

interface Props {
  msg: ChatMessageView
}


export default function UserMessageBubble({ msg }: Props): JSX.Element {
  const streaming = useAgentStore((s) => s.streaming)
  const editAndResend = useAgentStore((s) => s.editAndResend)
  const { body: displayText, forced } = useMemo(
    () => stripForcedInstruction(msg.content),
    [msg.content]
  )
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(displayText)
  const [zoomImage, setZoomImage] = useState<string | null>(null)
  const [lockedWidth, setLockedWidth] = useState<number | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const bubbleRef = useRef<HTMLDivElement>(null)

  const enterEdit = (): void => {
    // 进入编辑前先锁定气泡当前真实宽度：否则 textarea 的窄固有宽度会让
    // fit-content 气泡骤然缩窄，视觉上与展示态不一致。
    const w = bubbleRef.current?.getBoundingClientRect().width
    if (w) setLockedWidth(w)
    setEditing(true)
  }

  useEffect(() => {
    if (!editing) setDraft(displayText)
  }, [displayText, editing])

  useEffect(() => {
    if (!editing) return
    const el = inputRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
    const resize = (): void => {
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`
    }
    resize()
    el.addEventListener('input', resize)
    return () => el.removeEventListener('input', resize)
  }, [editing])

  const resend = (): void => {
    const text = (editing ? draft : displayText).trim()
    if (!text || streaming) return
    void editAndResend(msg.id, text)
    setEditing(false)
    setLockedWidth(null)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      setDraft(displayText)
      setEditing(false)
      setLockedWidth(null)
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      resend()
    }
  }

  const onBlur = (): void => {
    setDraft(displayText)
    setEditing(false)
    setLockedWidth(null)
  }

  return (
    <div className={`agent-msg user${editing ? ' is-editing' : ''}`}>
      {msg.images && msg.images.length > 0 && (
        <div className="agent-user-images">
          {msg.images.map((img, i) => (
            <img
              key={i}
              src={img.dataUrl}
              alt={img.name ?? '附图'}
              className="agent-user-image"
              loading="lazy"
              title="点击查看大图"
              onClick={() => setZoomImage(img.dataUrl)}
            />
          ))}
        </div>
      )}
      <div
        className="agent-user-bubble"
        ref={bubbleRef}
        style={editing && lockedWidth != null ? { width: lockedWidth } : undefined}
      >
        {editing ? (
          <textarea
            ref={inputRef}
            className="agent-user-bubble-input"
            value={draft}
            disabled={streaming}
            rows={1}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={onBlur}
          />
        ) : (
          <button
            type="button"
            className="agent-user-bubble-text"
            disabled={streaming}
            onClick={enterEdit}
            title="点击编辑"
          >
            <span className="agent-user-bubble-text-inner">{displayText}</span>
          </button>
        )}
        <button
          type="button"
          className="agent-user-bubble-resend"
          disabled={streaming || !(editing ? draft.trim() : displayText.trim())}
          title={editing ? '发送修改后的问题' : '用此问题重新发送'}
          aria-label="重新发送"
          onClick={(e) => {
            e.stopPropagation()
            resend()
          }}
        >
          <span className="agent-user-bubble-resend-icon" aria-hidden>
            ↩
          </span>
        </button>
      </div>
      <ForcedRefsBadge refs={forced} />
      {zoomImage && (
        <ImageLightbox src={zoomImage} alt="附图" onClose={() => setZoomImage(null)} />
      )}
    </div>
  )
}
