import { useTerminalStore } from '@/stores/terminalStore'
import { useUiStore } from '@/stores/uiStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import ResizeHandle from '@/components/common/ResizeHandle'
import XtermView from './XtermView'

export default function TerminalDock(): JSX.Element {
  const { sessions, activeId, setActive, closeSession, createSession } = useTerminalStore()
  const showTerminal = useUiStore((s) => s.showTerminal)
  const setTerminalVisible = useUiStore((s) => s.setTerminalVisible)
  const terminalHeight = useUiStore((s) => s.terminalHeight)

  const newTerminal = (): void => {
    const cwd = useWorkspaceStore.getState().workspace?.path
    void createSession(cwd)
  }

  
  
  return (
    <div
      className={`terminal-dock${showTerminal ? ' open' : ''}`}
      style={{ height: showTerminal ? terminalHeight : 0 }}
      aria-hidden={!showTerminal}
    >
      <ResizeHandle
        edge="top"
        title="拖动调整终端高度"
        getSize={() => useUiStore.getState().terminalHeight}
        onResize={(h) => useUiStore.getState().setTerminalHeight(h)}
      />
      <div className="terminal-dock-inner" style={{ height: terminalHeight }}>
        <div className="terminal-tabs">
          <div className="terminal-tabs-list">
            {sessions.map((s) => (
              <div
                key={s.id}
                className={`terminal-tab${s.id === activeId ? ' active' : ''}`}
                onClick={() => setActive(s.id)}
                title={s.cwd || s.title}
              >
                <span className="tt-icon">▸_</span>
                <span className="tt-title">{s.title}</span>
                <span
                  className="tt-close"
                  title="关闭终端"
                  onClick={(e) => {
                    e.stopPropagation()
                    void closeSession(s.id)
                  }}
                >
                  ×
                </span>
              </div>
            ))}
          </div>
          <div className="terminal-tools">
            <button
              className="btn-ghost"
              title="新建终端"
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onClick={newTerminal}
            >
              ＋
            </button>
            <button
              className="btn-ghost"
              title="收起面板"
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setTerminalVisible(false)}
            >
              ×
            </button>
          </div>
        </div>

        <div className="terminal-views">
          {sessions.length === 0 ? (
            <div className="terminal-empty">
              没有可用的终端会话。
              <button className="btn" style={{ marginLeft: 8 }} onClick={newTerminal}>
                新建终端
              </button>
            </div>
          ) : (
            sessions.map((s) => (
              <XtermView key={s.id} session={s} visible={s.id === activeId} />
            ))
          )}
        </div>
      </div>
    </div>
  )
}
