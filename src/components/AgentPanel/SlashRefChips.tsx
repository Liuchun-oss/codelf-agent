import type { SlashReference } from './slashCommand'

export interface SlashRefChipsProps {
  refs: SlashReference[]
  disabled?: boolean
  onRemove: (id: string) => void
}

// 已选「强制使用」的技能/插件 chip 列表，三处输入框（落地页/群聊/私聊）复用。
export default function SlashRefChips({ refs, disabled, onRemove }: SlashRefChipsProps): JSX.Element | null {
  if (refs.length === 0) return null
  return (
    <div className="agent-attachments" aria-label="强制使用的技能/插件">
      {refs.map((ref) => (
        <span key={`${ref.kind}:${ref.name}`} className={`agent-attachment-chip agent-slash-chip ${ref.kind}`}>
          <span
            className="agent-attachment-label"
            title={`强制使用${ref.kind === 'plugin' ? '插件' : '技能'}：${ref.name}`}
          >
            {ref.kind === 'plugin' ? '🧩' : '⚡'} /{ref.name}
          </span>
          <button
            type="button"
            className="agent-attachment-remove"
            aria-label="移除引用"
            disabled={disabled}
            onClick={() => onRemove(`${ref.kind}:${ref.name}`)}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  )
}
