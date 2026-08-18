import { useEffect, useRef, useState } from 'react'
import type { ContextAttachment, ImageAttachment, ProviderProfileSummary } from '@shared/agentTypes'
import { useAgentStore } from '@/stores/agentStore'
import { toWorkspaceRelative } from '@/utils/path'
import ContextPicker from './ContextPicker'
import SlashPicker from './SlashPicker'
import type { SlashReference } from './slashCommand'
import ContextUsageRing from '@/components/StatusBar/ContextUsageRing'
import ContextUsagePopover from '@/components/StatusBar/ContextUsagePopover'

export interface AgentComposerProps {
  /** 当前对话的工作目录（@ 文件选择与附件相对路径都以它为准），可为空 */
  workspaceRoot?: string
  input: string
  cursor: number
  attachments: ContextAttachment[]
  images: ImageAttachment[]
  supportsVision: boolean
  pickingPath: string | null
  showPicker: boolean
  pickerActive: number
  pickSignal: number
  atMentionQuery: string
  slashRefs: SlashReference[]
  showSlashPicker: boolean
  slashQuery: string
  slashActive: number
  slashPickSignal: number
  hasProfile: boolean
  streaming: boolean
  onInputChange: (value: string) => void
  onSyncCursor: () => void
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void
  onDropFiles: (e: React.DragEvent<HTMLTextAreaElement>) => void
  onSend: () => void
  onStop: () => void
  onPick: (item: import('./ContextPicker').PickItem) => void
  onPickerActiveChange: (index: number) => void
  onPickerRowCount: (count: number) => void
  onSlashPick: (item: import('./SlashPicker').SlashItem) => void
  onSlashActiveChange: (index: number) => void
  onSlashRowCount: (count: number) => void
  onRemoveSlashRef: (id: string) => void
  onRemoveAttachment: (path: string) => void
  onRemoveImage: (dataUrl: string) => void
  textareaRef: React.RefObject<HTMLTextAreaElement>
}


export default function AgentComposer(props: AgentComposerProps): JSX.Element {

  const {
    workspaceRoot,
    input,
    attachments,
    images,
    supportsVision,
    pickingPath,
    showPicker,
    pickerActive,
    pickSignal,
    atMentionQuery,
    slashRefs,
    showSlashPicker,
    slashQuery,
    slashActive,
    slashPickSignal,
    hasProfile,
    streaming,
    onInputChange,
    onSyncCursor,
    onKeyDown,
    onPaste,
    onDropFiles,
    onSend,
    onStop,
    onPick,
    onPickerActiveChange,
    onPickerRowCount,
    onSlashPick,
    onSlashActiveChange,
    onSlashRowCount,
    onRemoveSlashRef,
    onRemoveAttachment,
    onRemoveImage,
    textareaRef
  } = props

  const activeProfile = useAgentStore((s) => s.activeProfile)
  const permissionMode = useAgentStore((s) => s.permissionMode)
  const setPermissionMode = useAgentStore((s) => s.setPermissionMode)
  const currentSessionId = useAgentStore((s) => s.currentSessionId)
  const sessionProfileId = useAgentStore(
    (s) => s.sessions.find((m) => m.id === s.currentSessionId)?.profileId ?? null
  )
  const setSessionProfile = useAgentStore((s) => s.setSessionProfile)
  const [profiles, setProfiles] = useState<ProviderProfileSummary[]>([])
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const modelMenuRef = useRef<HTMLDivElement>(null)
  const lastTokenUsage = useAgentStore((s) => s.lastTokenUsage)
  const breakdown = lastTokenUsage?.contextBreakdown
  const [contextOpen, setContextOpen] = useState(false)
  const ringRef = useRef<HTMLDivElement>(null)

  // 会话级切换不再改动全局激活态，因此主要靠 profilesChanged 事件刷新列表。
  // 同时保留 activeProfile?.id 依赖作兜底：onProfilesChanged 缺失时仍能跟随
  // store 的全局刷新重新拉取，不会永久停在过期列表上。
  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      void window.lc.aiListProfiles().then((list) => {
        if (!cancelled) setProfiles(list)
      })
    }
    load()
    const off = window.lc.onProfilesChanged?.(load)
    return () => {
      cancelled = true
      off?.()
    }
  }, [activeProfile?.id])

  useEffect(() => {
    if (!modelMenuOpen) return
    const onDown = (e: MouseEvent): void => {
      if (!modelMenuRef.current?.contains(e.target as Node)) setModelMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        // 阻断后续 Esc 监听（如 HomeScreen 的“退出对话”），关菜单不应连带退出
        e.preventDefault()
        setModelMenuOpen(false)
      }
    }
    window.addEventListener('mousedown', onDown, true)
    // capture：保证先于 HomeScreen 的 window 级 Esc 监听执行
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [modelMenuOpen])

  // 当前对话生效的模型：会话绑定优先，未绑定（或绑定的 profile 已被删除）则跟随全局默认模型，
  // 与主进程 submitTurn 的回退顺序保持一致。
  const boundProfile = sessionProfileId ? profiles.find((p) => p.id === sessionProfileId) : undefined
  const effectiveProfile = boundProfile ?? activeProfile

  // 只改当前对话的绑定，不动全局默认模型，因此其他对话不受影响。
  const switchProfile = (id: string): void => {
    setModelMenuOpen(false)
    if (!id || id === effectiveProfile?.id || !currentSessionId) return
    setSessionProfile(currentSessionId, id)
  }

  // 菜单展示全部已配置模型（含当前），当前项高亮并打勾；只有一个模型时无需展开。
  const canOpenMenu = profiles.length > 1
  const modelSwitcherDisabled = streaming || profiles.length === 0 || !canOpenMenu

  return (
    <div className="agent-composer">
      <div className="agent-composer-box">
        {slashRefs.length > 0 && (
          <div className="agent-attachments" aria-label="强制使用的技能/插件">
            {slashRefs.map((ref) => (
              <span
                key={`${ref.kind}:${ref.name}`}
                className={`agent-attachment-chip agent-slash-chip ${ref.kind}`}
              >
                <span className="agent-attachment-label" title={`强制使用${ref.kind === 'plugin' ? '插件' : '技能'}：${ref.name}`}>
                  {ref.kind === 'plugin' ? '🧩' : '⚡'} /{ref.name}
                </span>
                <button
                  type="button"
                  className="agent-attachment-remove"
                  aria-label="移除引用"
                  disabled={streaming}
                  onClick={() => onRemoveSlashRef(`${ref.kind}:${ref.name}`)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        {attachments.length > 0 && (
          <div className="agent-attachments" aria-label="已附加文件">
            {attachments.map((att) => (
              <span key={att.path} className="agent-attachment-chip">
                <span className="agent-attachment-label" title={att.path}>
                  @
                  {att.kind === 'rule'
                    ? att.path
                    : workspaceRoot
                      ? toWorkspaceRelative(workspaceRoot, att.path!)
                      : att.path}
                </span>
                <button
                  type="button"
                  className="agent-attachment-remove"
                  aria-label="移除附件"
                  disabled={streaming}
                  onClick={() => att.path && onRemoveAttachment(att.path)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        {images.length > 0 && (
          <div className="agent-image-strip" aria-label="已附加图片">
            {images.map((img) => (
              <span key={img.dataUrl} className="agent-image-chip">
                <img src={img.dataUrl} alt={img.name ?? '图片'} className="agent-image-thumb" />
                <button
                  type="button"
                  className="agent-image-remove"
                  aria-label="移除图片"
                  disabled={streaming}
                  onClick={() => onRemoveImage(img.dataUrl)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        {showPicker && workspaceRoot && (
          <ContextPicker
            query={atMentionQuery}
            workspaceRoot={workspaceRoot}
            activeIndex={pickerActive}
            onActiveIndexChange={onPickerActiveChange}
            onPick={onPick}
            pickSignal={pickSignal}
            onRowCountChange={onPickerRowCount}
          />
        )}

        {showSlashPicker && (
          <SlashPicker
            query={slashQuery}
            workspaceRoot={workspaceRoot}
            activeIndex={slashActive}
            onActiveIndexChange={onSlashActiveChange}
            onPick={onSlashPick}
            pickSignal={slashPickSignal}
            onRowCountChange={onSlashRowCount}
          />
        )}

        <textarea
          ref={textareaRef}
          className="agent-composer-input"
          value={input}
          placeholder={
            hasProfile
              ? supportsVision
                ? '规划、构建；@ 附加上下文，/ 引用技能或插件，可粘贴图片，Enter 发送，Shift+Enter 换行'
                : '规划、构建；@ 附加上下文，/ 引用技能或插件，Enter 发送，Shift+Enter 换行'
              : '请先在设置中配置 Provider'
          }
          disabled={!hasProfile || !!pickingPath}
          rows={3}
          onChange={(e) => onInputChange(e.target.value)}
          onSelect={onSyncCursor}
          onClick={onSyncCursor}
          onKeyUp={onSyncCursor}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onDragOver={(e) => {
            if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault()
          }}
          onDrop={onDropFiles}
        />

        <div className="agent-composer-toolbar">
          <div className="agent-composer-toolbar-left">
            <div className="agent-composer-model-switcher" ref={modelMenuRef}>
              <button
                type="button"
                className="agent-composer-model-trigger"
                title={
                  !effectiveProfile
                    ? '未配置模型'
                    : streaming
                      ? '生成中无法切换模型'
                      : !canOpenMenu
                        ? `${effectiveProfile.name} · ${effectiveProfile.model}（仅此一个可用模型）`
                        : `${effectiveProfile.name} · ${effectiveProfile.model}（仅切换当前对话）`
                }
                disabled={modelSwitcherDisabled}
                aria-haspopup="listbox"
                aria-expanded={modelMenuOpen}
                onClick={() => setModelMenuOpen((open) => !open)}
              >
                <span>
                  {effectiveProfile ? `${effectiveProfile.name} · ${effectiveProfile.model}` : '未配置模型'}
                </span>
                {canOpenMenu && (
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
                    <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </button>
              {modelMenuOpen && profiles.length > 0 && (
                <div className="agent-composer-model-menu" role="listbox">
                  {profiles.map((profile) => {
                    const isActive = profile.id === effectiveProfile?.id
                    return (
                      <button
                        key={profile.id}
                        type="button"
                        className={`agent-composer-model-option${isActive ? ' active' : ''}`}
                        role="option"
                        aria-selected={isActive}
                        title={`${profile.name} · ${profile.model}`}
                        onClick={() => switchProfile(profile.id)}
                      >
                        <span className="agent-composer-model-check" aria-hidden>
                          {isActive ? '✓' : ''}
                        </span>
                        {profile.name} · {profile.model}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
            <label
              className="agent-composer-toolbar-accept"
              title="自动审批文件修改和普通终端命令；危险操作仍需确认"
            >
              <input
                type="checkbox"
                checked={permissionMode === 'acceptEdits'}
                onChange={(e) => setPermissionMode(e.target.checked ? 'acceptEdits' : 'default')}
              />
              自动审批
            </label>
          </div>
          <div className="agent-composer-toolbar-right">
            {pickingPath && <span className="agent-picking-hint">正在读取…</span>}
            <div className="agent-composer-context" ref={ringRef}>
              <ContextUsageRing
                breakdown={breakdown}
                open={contextOpen}
                onClick={() => setContextOpen((v) => !v)}
              />
            </div>
            {streaming ? (
              <button type="button" className="agent-composer-send secondary" onClick={onStop}>
                停止
              </button>
            ) : (
              <button
                type="button"
                className="agent-composer-send"
                disabled={!hasProfile || (!input.trim() && images.length === 0) || !!pickingPath}
                onClick={onSend}
              >
                发送
              </button>
            )}
          </div>
        </div>
      </div>
      <ContextUsagePopover
        open={contextOpen}
        onClose={() => setContextOpen(false)}
        breakdown={breakdown}
        usage={lastTokenUsage}
        anchorRef={ringRef}
      />
    </div>
  )
}
