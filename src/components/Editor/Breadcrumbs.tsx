import { useEditorStore } from '@/stores/editorStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useUiStore } from '@/stores/uiStore'
import { gotoSymbol } from './editorBridge'
import { getSep } from '@/utils/path'
import FileIcon from '@/components/common/FileIcon'

interface Crumb {
  name: string
  path: string
  isFile: boolean
}

export default function Breadcrumbs(): JSX.Element | null {
  const tabs = useEditorStore((s) => s.tabs)
  const activeTabPath = useEditorStore((s) => s.activeTabPath)
  const workspace = useWorkspaceStore((s) => s.workspace)

  const activeTab = tabs.find((t) => t.path === activeTabPath) ?? null
  if (!activeTab || activeTab.untitled) return null

  const full = activeTab.path
  const sep = getSep(full)
  
  const base = workspace && full.startsWith(workspace.path + sep) ? workspace.path.length + 1 : 0
  const rel = full.slice(base)
  const parts = rel.split(/[\\/]/).filter(Boolean)

  const crumbs: Crumb[] = []
  let acc = base > 0 ? workspace!.path : full.slice(0, full.indexOf(sep) + 1)
  parts.forEach((name, i) => {
    acc = i === 0 && base === 0 ? acc + name : acc + sep + name
    crumbs.push({ name, path: acc, isFile: i === parts.length - 1 })
  })

  const onCrumb = (c: Crumb): void => {
    if (c.isFile) {
      if (activeTab.kind !== 'text') return
      void gotoSymbol()
    } else {
      useUiStore.getState().openSidebarView('explorer')
      useWorkspaceStore.getState().expandFolder(c.path)
      void useWorkspaceStore.getState().refreshTree()
    }
  }

  return (
    <div className="breadcrumbs">
      {crumbs.map((c, i) => (
        <span key={c.path} className="crumb-wrap">
          {i > 0 && <span className="crumb-sep">›</span>}
          <span className="crumb" onClick={() => onCrumb(c)}>
            {c.isFile && <FileIcon name={c.name} size={14} />}
            {c.name}
          </span>
        </span>
      ))}
    </div>
  )
}
