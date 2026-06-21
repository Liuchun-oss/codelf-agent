import type { ChatMessageView } from '@/stores/agentStore'
import { useAgentStore } from '@/stores/agentStore'


export default function PermissionPrompt({ msg }: { msg: ChatMessageView }): JSX.Element | null {
  const respond = useAgentStore((s) => s.respondPermission)
  const pending = msg.permissionStatus === 'pending'
  const cmd = msg.permissionCommand?.trim()

  if (!pending) {
    if (msg.permissionStatus !== 'deny') return null

    return (
      <div className="agent-meta-line perm deny">
        <span className="agent-meta-dot" />
        <span>已拒绝</span>
        {cmd ? <code className="agent-meta-code">{cmd}</code> : null}
      </div>
    )
  }

  return (
    <div className="agent-perm-pending">
      <div className="agent-perm-pending-head">
        <span>运行命令需确认</span>
      </div>
      {cmd ? <pre className="agent-perm-pending-cmd">{cmd}</pre> : null}
      <div className="agent-perm-pending-actions">
        <button type="button" className="agent-perm-pending-btn primary" onClick={() => respond(msg.id, 'allow_once')}>
          允许
        </button>
        <button type="button" className="agent-perm-pending-btn" onClick={() => respond(msg.id, 'allow_session')}>
          本会话
        </button>
        <button type="button" className="agent-perm-pending-btn" onClick={() => respond(msg.id, 'allow_project')}>
          项目
        </button>
        <button type="button" className="agent-perm-pending-btn subtle" onClick={() => respond(msg.id, 'deny')}>
          拒绝
        </button>
      </div>
    </div>
  )
}
