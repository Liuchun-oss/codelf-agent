import type { SlashReference } from './slashCommand'

// 用户气泡里的小徽标：提示这条消息强制要求了哪些技能/插件（正文里的指令已被剥离）。
export default function ForcedRefsBadge({ refs }: { refs: SlashReference[] }): JSX.Element | null {
  if (refs.length === 0) return null
  return (
    <div className="agent-forced-refs" aria-label="本条消息强制使用">
      {refs.map((ref) => (
        <span key={`${ref.kind}:${ref.name}`} className={`agent-forced-ref ${ref.kind}`} title={`已强制使用${ref.kind === 'plugin' ? '插件' : '技能'}：${ref.name}`}>
          {ref.kind === 'plugin' ? '🧩' : '⚡'} {ref.name}
        </span>
      ))}
    </div>
  )
}
