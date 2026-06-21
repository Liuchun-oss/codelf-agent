import { useEffect } from 'react'
import ResizeHandle from '@/components/common/ResizeHandle'
import { useUiStore } from '@/stores/uiStore'
import { useAgentStore } from '@/stores/agentStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import AgentPanelHeader from './AgentPanelHeader'
import ConversationView from './ConversationView'

export default function AgentPanel(): JSX.Element {
  const showAgentPanel = useUiStore((s) => s.showAgentPanel)
  const agentWidth = useUiStore((s) => s.agentWidth)
  const workspaceRoot = useWorkspaceStore((s) => s.workspace?.path)

  const init = useAgentStore((s) => s.init)
  const sessionCwd = useAgentStore(
    (s) => s.sessions.find((m) => m.id === s.currentSessionId)?.cwd ?? null
  )

  useEffect(() => {
    init()
  }, [init])

  return (
    <div
      className={`agent-dock${showAgentPanel ? ' open' : ''}`}
      style={{ width: showAgentPanel ? agentWidth : 0 }}
      aria-hidden={!showAgentPanel}
    >
      <div className="agent-dock-inner" style={{ width: agentWidth }}>
        <div className="agent-panel">
          <ResizeHandle
            edge="left"
            title="拖动调整 AI 面板宽度"
            getSize={() => useUiStore.getState().agentWidth}
            onResize={(w) => useUiStore.getState().setAgentWidth(w)}
          />

          <AgentPanelHeader />

          <ConversationView cwd={sessionCwd ?? workspaceRoot ?? null} />
        </div>
      </div>
    </div>
  )
}
