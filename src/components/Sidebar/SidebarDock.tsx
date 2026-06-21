import { useLayoutEffect, useRef } from 'react'
import FileTree from '@/components/FileTree/FileTree'
import SearchPanel from '@/components/Search/SearchPanel'
import SourceControlPanel from '@/components/SourceControl/SourceControlPanel'
import KnowledgePanel from '@/components/Knowledge/KnowledgePanel'
import { useUiStore } from '@/stores/uiStore'

const VIEW_ORDER: Record<string, number> = { explorer: 0, search: 1, scm: 2, knowledge: 3 }

export default function SidebarDock(): JSX.Element {
  const showFileTree = useUiStore((s) => s.showFileTree)
  const sidebarWidth = useUiStore((s) => s.sidebarWidth)
  const sidebarView = useUiStore((s) => s.sidebarView)
  const stackRef = useRef<HTMLDivElement>(null)
  const prevViewRef = useRef(sidebarView)

  useLayoutEffect(() => {
    const stack = stackRef.current
    if (!stack) return
    const prev = prevViewRef.current
    if (prev === sidebarView) return
    const dir = (VIEW_ORDER[sidebarView] ?? 0) - (VIEW_ORDER[prev] ?? 0)
    stack.dataset.dir = dir >= 0 ? '1' : '-1'
    prevViewRef.current = sidebarView
  }, [sidebarView])

  return (
    <div
      className={`sidebar-dock${showFileTree ? ' open' : ''}`}
      style={{ width: showFileTree ? sidebarWidth : 0 }}
      aria-hidden={!showFileTree}
    >
      <div className="sidebar-dock-inner" style={{ width: sidebarWidth }}>
        <div ref={stackRef} className="sidebar-view-stack">
          <div className={`sidebar-view-pane${sidebarView === 'explorer' ? ' is-active' : ''}`}>
            <FileTree />
          </div>
          <div className={`sidebar-view-pane${sidebarView === 'search' ? ' is-active' : ''}`}>
            <SearchPanel />
          </div>
          <div className={`sidebar-view-pane${sidebarView === 'scm' ? ' is-active' : ''}`}>
            <SourceControlPanel />
          </div>
          <div className={`sidebar-view-pane${sidebarView === 'knowledge' ? ' is-active' : ''}`}>
            <KnowledgePanel />
          </div>
        </div>
      </div>
    </div>
  )
}
