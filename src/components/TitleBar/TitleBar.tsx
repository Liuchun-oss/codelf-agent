import { useEffect, useRef, useState } from 'react'
import AppMenubarPanel from '@/components/TitleBar/AppMenubarPanel'
import { APP_NAME } from '@shared/appConfig'
import appIcon from '@/assets/app-icon.png'
import { useUiStore } from '@/stores/uiStore'
import { useAgentStore } from '@/stores/agentStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

const MENUS = ['文件', '编辑', '视图', '构建', '终端', '帮助'] as const

function MaximizeIcon({ restored }: { restored: boolean }): JSX.Element {
  if (restored) {
    return (
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
        {}
        <rect x="3" y="1" width="6" height="6" fill="none" stroke="currentColor" strokeWidth="1" />
        {}
        <rect x="1" y="3" width="6" height="6" fill="var(--bg-elevated)" stroke="currentColor" strokeWidth="1" />
      </svg>
    )
  }
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  )
}

export default function TitleBar(): JSX.Element {
  const [maximized, setMaximized] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuHighlight, setMenuHighlight] = useState(false)
  const [activeMenu, setActiveMenu] = useState(0)
  const menuBtnRefs = useRef<(HTMLButtonElement | null)[]>([])
  const requestMenuCloseRef = useRef<(() => void) | null>(null)
  const menuPointerRef = useRef<{ index: number; wasOpen: boolean; initialActive: number } | null>(
    null
  )

  // IDE 菜单（文件/编辑/视图…）只在工作台视图有意义，非 IDE 模式整排隐藏
  const appView = useUiStore((s) => s.appView)
  const showMenus = appView === 'workspace'

  // 全局视图切换：进 IDE 时若尚未打开工作区，自动以当前会话 cwd 打开
  const goIde = async (): Promise<void> => {
    const ws = useWorkspaceStore.getState()
    const pickedWs = useUiStore.getState().homePickedWorkspace

    // 如果对话模式选择了工作区（不是 null）
    if (pickedWs) {
      // 且和当前工作区不同，打开它
      if (ws.workspace?.path !== pickedWs.path) {
        await ws.openWorkspacePath(pickedWs)
      }
    } else if (!ws.workspace) {
      // 对话模式没选择工作区（null），且当前也没有打开工作区
      // 尝试激活历史工作区或使用会话 cwd
      if (ws.lastWorkspace) {
        await ws.activateWorkspace()
      } else {
        const ag = useAgentStore.getState()
        const cwd = ag.sessions.find((m) => m.id === ag.currentSessionId)?.cwd ?? null
        if (cwd) await ws.openWorkspacePath({ path: cwd, name: basename(cwd) })
      }
    }
    // 如果对话模式选了 null，且 IDE 已有工作区打开，保持不变

    // 最后切换视图
    useUiStore.getState().setAppView('workspace')
  }

  useEffect(() => {
    void window.lc.windowIsMaximized().then(setMaximized)
    return window.lc.onWindowMaximized(setMaximized)
  }, [])

  // 切出 IDE 视图时收起可能展开的菜单面板
  useEffect(() => {
    if (!showMenus && menuOpen) {
      setMenuHighlight(false)
      setMenuOpen(false)
    }
  }, [showMenus, menuOpen])

  const openMenu = (index: number): void => {
    setActiveMenu(index)
    setMenuOpen(true)
    setMenuHighlight(true)
  }

  const onMenuMouseDown = (index: number, e: React.MouseEvent): void => {
    if (e.button !== 0) return
    e.preventDefault()
    menuPointerRef.current = { index, wasOpen: menuOpen, initialActive: activeMenu }
    if (!menuOpen) {
      openMenu(index)
    } else if (activeMenu !== index) {
      setActiveMenu(index)
    }
  }

  const onMenuClick = (index: number): void => {
    const down = menuPointerRef.current
    menuPointerRef.current = null
    if (!down?.wasOpen) return
    if (down.index === down.initialActive && down.index === index && activeMenu === index) {
      setMenuHighlight(false)
      setMenuOpen(false)
    }
  }

  const onMenuEnter = (index: number): void => {
    if (menuOpen) setActiveMenu(index)
  }

  const onTitlebarMouseDown = (e: React.MouseEvent<HTMLElement>): void => {
    if (!menuOpen) return
    const t = e.target as Node
    if (menuBtnRefs.current.some((btn) => btn?.contains(t))) return
    requestMenuCloseRef.current?.()
  }

  return (
    <>
      <header
        className={`titlebar${menuOpen ? ' titlebar--menu-open' : ''}`}
        data-testid="titlebar"
        onMouseDownCapture={onTitlebarMouseDown}
      >
        <div className="titlebar-left">
          <div className="titlebar-icon" title={APP_NAME}>
            <img className="titlebar-mark" src={appIcon} alt="" aria-hidden />
          </div>

          {!showMenus && <span className="titlebar-app-name">{APP_NAME}</span>}

          {showMenus && (
            <nav className="titlebar-menus" aria-label="应用菜单">
              {MENUS.map((label, index) => (
                <button
                  key={label}
                  ref={(el) => {
                    menuBtnRefs.current[index] = el
                  }}
                  type="button"
                  className={`titlebar-menu-btn${menuHighlight && activeMenu === index ? ' active' : ''}`}
                  onMouseDown={(e) => onMenuMouseDown(index, e)}
                  onMouseEnter={() => onMenuEnter(index)}
                  onClick={() => onMenuClick(index)}
                >
                  {label}
                </button>
              ))}
            </nav>
          )}
        </div>

        <div
          className="titlebar-view-switch"
          role="tablist"
          aria-label="视图切换"
          data-active={appView === 'workspace' ? 'workspace' : 'home'}
        >
          <span className="titlebar-view-thumb" aria-hidden />
          <button
            type="button"
            role="tab"
            aria-selected={appView === 'home'}
            className={`titlebar-view-btn${appView === 'home' ? ' active' : ''}`}
            title="对话视图"
            onClick={() => useUiStore.getState().setAppView('home')}
          >
            对话
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={appView === 'workspace'}
            className={`titlebar-view-btn${appView === 'workspace' ? ' active' : ''}`}
            title="IDE 工作台"
            onClick={goIde}
          >
            IDE
          </button>
        </div>

        {/* 拖拽区双击最大化由系统标题栏（HTCAPTION）原生处理 */}

        <div className="titlebar-controls">
          <button
            type="button"
            className="titlebar-control"
            title="最小化"
            aria-label="最小化"
            onClick={() => window.lc.windowMinimize()}
          >
            <svg width="10" height="1" viewBox="0 0 10 1" aria-hidden>
              <rect width="10" height="1" fill="currentColor" />
            </svg>
          </button>
          <button
            type="button"
            className="titlebar-control"
            title={maximized ? '向下还原' : '最大化'}
            aria-label={maximized ? '向下还原' : '最大化'}
            onClick={() => window.lc.windowMaximize()}
          >
            <MaximizeIcon restored={maximized} />
          </button>
          <button
            type="button"
            className="titlebar-control titlebar-control--close"
            title="关闭"
            aria-label="关闭"
            onClick={() => window.lc.windowClose()}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
              <path stroke="currentColor" strokeWidth="1.1" d="M1 1l8 8M9 1L1 9" />
            </svg>
          </button>
        </div>
      </header>

      {showMenus && menuOpen && (
        <AppMenubarPanel
          activeIndex={activeMenu}
          buttonRefs={menuBtnRefs}
          requestCloseRef={requestMenuCloseRef}
          onClosing={() => setMenuHighlight(false)}
          onClose={() => setMenuOpen(false)}
        />
      )}
    </>
  )
}
