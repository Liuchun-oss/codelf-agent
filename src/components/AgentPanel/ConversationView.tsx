import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ContextAttachment, ImageAttachment } from '@shared/agentTypes'
import { useUiStore } from '@/stores/uiStore'
import { useAgentStore } from '@/stores/agentStore'
import { toast } from '@/stores/toastStore'
import { pathsEqual } from '@/utils/path'
import MessageList from './MessageList'
import AgentComposer from './AgentComposer'
import { detectAtMention, removeAtMention } from './atMention'
import type { PickItem } from './ContextPicker'
import {
  appendAttachment,
  loadFileAttachment,
  loadFolderAttachment,
  buildRuleAttachment
} from './contextAttachment'
import { fileToImageAttachment, appendImage } from './imageAttachment'

interface ConversationViewProps {
  /** 当前对话使用的工作目录（@ 文件选择等依赖它），可为空 */
  cwd?: string | null
  /** 挂载/切换会话时自动聚焦输入框（首页全宽聊天用；侧边 dock 不抢编辑器焦点） */
  autoFocus?: boolean
}

/**
 * 对话视图：消息流 + 输入框。
 * 被 AgentPanel（右侧 dock）与 HomeScreen（全宽聊天）共用。
 */
export default function ConversationView({ cwd, autoFocus }: ConversationViewProps): JSX.Element {
  const [input, setInput] = useState('')
  const [cursor, setCursor] = useState(0)
  const [pickerActive, setPickerActive] = useState(0)
  const [attachments, setAttachments] = useState<ContextAttachment[]>([])
  const [images, setImages] = useState<ImageAttachment[]>([])
  const [pickSignal, setPickSignal] = useState(0)
  const [pickerRowCount, setPickerRowCount] = useState(0)
  const [pickingPath, setPickingPath] = useState<string | null>(null)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const workspaceRoot = cwd ?? undefined

  const streaming = useAgentStore((s) => s.streaming)
  const messages = useAgentStore((s) => s.messages)
  const currentSessionId = useAgentStore((s) => s.currentSessionId)
  const activeProfile = useAgentStore((s) => s.activeProfile)
  const sendMessage = useAgentStore((s) => s.sendMessage)
  const stop = useAgentStore((s) => s.stop)

  const syncCursor = useCallback((): void => {
    const el = textareaRef.current
    if (el) setCursor(el.selectionStart ?? 0)
  }, [])

  const atMention = useMemo(() => detectAtMention(input, cursor), [input, cursor])

  const showPicker = !!atMention && !!workspaceRoot && !streaming && pickingPath === null

  useEffect(() => {
    setPickerActive(0)
  }, [atMention?.query, showPicker])

  useEffect(() => {
    if (!showPicker) setPickSignal(0)
  }, [showPicker])

  // 打开/切换会话时聚焦输入框，到手即可打字
  useEffect(() => {
    if (!autoFocus) return
    const el = textareaRef.current
    if (el && !el.disabled) el.focus()
  }, [autoFocus, currentSessionId])

  const hasProfile = !!activeProfile
  const empty = messages.length === 0
  const openTabs = useAgentStore((s) => s.openTabs)
  const sessions = useAgentStore((s) => s.sessions)
  const activeSessionOpen = !!currentSessionId && openTabs.includes(currentSessionId)
  const activeSessionExists = sessions.some((session) => session.id === currentSessionId)
  const noSession = !activeSessionOpen || !activeSessionExists

  const applyPick = useCallback(
    async (item: PickItem): Promise<void> => {
      if (pickingPath) return
      setPickingPath(item.id)
      try {
        const att =
          item.kind === 'rule'
            ? buildRuleAttachment(item.name, item.ruleBody)
            : item.kind === 'folder' && workspaceRoot
              ? await loadFolderAttachment(item.id, workspaceRoot)
              : await loadFileAttachment(item.id)
        if (!att) return

        if (atMention) {
          const { text, cursor: nextCur } = removeAtMention(input, atMention)
          setInput(text)
          requestAnimationFrame(() => {
            const el = textareaRef.current
            if (el) {
              el.focus()
              el.setSelectionRange(nextCur, nextCur)
              setCursor(nextCur)
            }
          })
        }

        setAttachments((prev) => appendAttachment(prev, att))
      } finally {
        setPickingPath(null)
      }
    },
    [pickingPath, atMention, input, workspaceRoot]
  )

  const supportsVision = !!activeProfile?.supportsVision

  const onSend = (): void => {
    const trimmed = input.trim()
    const hasImages = images.length > 0
    if (!trimmed && !hasImages) return
    if (streaming) {
      // 不静默吞掉发送：告知用户当前状态与出路
      toast.warn('正在生成回复，请等待完成或点击「停止」')
      return
    }
    if (atMention) {
      toast.warn('请先完成 @ 文件选择或删除 @ 提及')
      return
    }
    const toSend = attachments.length > 0 ? [...attachments] : undefined
    const imgs = hasImages ? [...images] : undefined
    void sendMessage(trimmed, toSend, imgs)
    setInput('')
    setCursor(0)
    setAttachments([])
    setImages([])
  }

  const onPaste = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>): Promise<void> => {
      const items = Array.from(e.clipboardData?.items ?? [])
      const imageItems = items.filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      if (imageItems.length === 0) return
      e.preventDefault()
      if (!supportsVision) {
        toast.warn('当前模型不支持图片输入')
        return
      }
      for (const it of imageItems) {
        const file = it.getAsFile()
        if (!file) continue
        const att = await fileToImageAttachment(file)
        if (att) setImages((prev) => appendImage(prev, att))
      }
    },
    [supportsVision]
  )

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (showPicker) {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (atMention) {
          const { text, cursor: nextCur } = removeAtMention(input, atMention)
          setInput(text)
          setCursor(nextCur)
        }
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setPickerActive((i) => (pickerRowCount > 0 ? Math.min(i + 1, pickerRowCount - 1) : 0))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setPickerActive((i) => Math.max(0, i - 1))
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        setPickSignal((n) => n + 1)
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        setPickSignal((n) => n + 1)
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onSend()
    }
  }

  return (
    <>
      <div className="agent-panel-main">
        <div className="agent-panel-scroll" ref={scrollRef}>
          {noSession ? (
            <div className="agent-placeholder">
              <p className="agent-placeholder-title">没有打开的对话</p>
              <p>点击历史记录打开对话，或新建一个对话开始。</p>
            </div>
          ) : empty ? (
            <div className="agent-placeholder">
              {hasProfile ? (
                <>
                  <p className="agent-placeholder-title">Agent</p>
                  <p>
                    已连接 {activeProfile?.name}（{activeProfile?.model}）
                  </p>
                  <p>
                    在下方输入任务；<code>@文件</code> 附加上下文。变更会以卡片形式出现在对话流中。
                  </p>
                </>
              ) : (
                <>
                  <p>尚未配置 AI Provider。</p>
                  <button className="btn" onClick={() => useUiStore.getState().setShowSettings(true)}>
                    前往设置配置
                  </button>
                </>
              )}
            </div>
          ) : (
            <MessageList key={currentSessionId} scrollContainerRef={scrollRef} />
          )}
        </div>
      </div>

      {!noSession && (
        <AgentComposer
          workspaceRoot={workspaceRoot}
          input={input}
          cursor={cursor}
          attachments={attachments}
          images={images}
          supportsVision={supportsVision}
          pickingPath={pickingPath}
          showPicker={showPicker}
          pickerActive={pickerActive}
          pickSignal={pickSignal}
          atMentionQuery={atMention?.query ?? ''}
          hasProfile={hasProfile}
          streaming={streaming}
          textareaRef={textareaRef}
          onInputChange={setInput}
          onSyncCursor={syncCursor}
          onKeyDown={onKeyDown}
          onPaste={(e) => void onPaste(e)}
          onSend={onSend}
          onStop={stop}
          onPick={(item) => void applyPick(item)}
          onPickerActiveChange={setPickerActive}
          onPickerRowCount={setPickerRowCount}
          onRemoveAttachment={(path) =>
            setAttachments((prev) => prev.filter((a) => !(a.path && pathsEqual(a.path, path))))
          }
          onRemoveImage={(dataUrl) => setImages((prev) => prev.filter((i) => i.dataUrl !== dataUrl))}
        />
      )}
    </>
  )
}
