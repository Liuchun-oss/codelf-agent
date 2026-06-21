import { useLayoutEffect, useMemo, useRef, useState, Children, type MouseEvent, type KeyboardEvent, type DragEvent, type ReactNode } from 'react'
import type { FileTreeNode } from '@/types'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useEditorStore } from '@/stores/editorStore'
import { useTerminalStore } from '@/stores/terminalStore'
import { useDialogStore } from '@/stores/dialogStore'
import FileIcon from '@/components/common/FileIcon'
import { dirname, basename } from '@/utils/path'
import { validateName } from '@/utils/validateName'
import ContextMenu, { type MenuItem } from '@/components/common/ContextMenu'
import ResizeHandle from '@/components/common/ResizeHandle'
import { useUiStore } from '@/stores/uiStore'
import { DND_PATHS_MIME } from '@shared/appConfig'

interface MenuState {
  x: number
  y: number
  node: FileTreeNode | null 
  sel: string[] 
}

function findNode(nodes: FileTreeNode[], path: string): FileTreeNode | null {
  for (const n of nodes) {
    if (n.path === path) return n
    if (n.children) {
      const found = findNode(n.children, path)
      if (found) return found
    }
  }
  return null
}


function flattenVisible(
  nodes: FileTreeNode[],
  expanded: Set<string>,
  out: FileTreeNode[] = []
): FileTreeNode[] {
  for (const n of nodes) {
    out.push(n)
    if (n.type === 'directory' && expanded.has(n.path) && n.children) {
      flattenVisible(n.children, expanded, out)
    }
  }
  return out
}

async function showError(message: string): Promise<void> {
  await useDialogStore.getState().confirm({
    title: '操作失败',
    message,
    confirmText: '知道了',
    cancelText: '关闭'
  })
}

async function promptNewFile(parentPath: string): Promise<void> {
  const name = await useDialogStore.getState().prompt({
    title: '新建文件',
    label: `位置：${parentPath}`,
    placeholder: '文件名，例如 index.ts',
    confirmText: '创建',
    validate: validateName
  })
  if (name === null) return
  const res = await useWorkspaceStore.getState().createFile(parentPath, name)
  if (!res.ok) await showError(res.error ?? '创建文件失败')
}

async function promptNewFolder(parentPath: string): Promise<void> {
  const name = await useDialogStore.getState().prompt({
    title: '新建文件夹',
    label: `位置：${parentPath}`,
    placeholder: '文件夹名',
    confirmText: '创建',
    validate: validateName
  })
  if (name === null) return
  const res = await useWorkspaceStore.getState().createFolder(parentPath, name)
  if (!res.ok) await showError(res.error ?? '创建文件夹失败')
}

async function promptRename(node: FileTreeNode): Promise<void> {
  const dot = node.name.lastIndexOf('.')
  const selectionEnd = node.type === 'file' && dot > 0 ? dot : node.name.length
  const newName = await useDialogStore.getState().prompt({
    title: '重命名',
    label: `原名称：${node.name}`,
    defaultValue: node.name,
    selectionEnd,
    confirmText: '重命名',
    validate: validateName
  })
  if (newName === null || newName === node.name) return
  const res = await useWorkspaceStore.getState().renameItem(node.path, newName)
  if (!res.ok) await showError(res.error ?? '重命名失败')
}

interface DragProps {
  dragOverPath: string | null
  onDragStart: (e: React.DragEvent, node: FileTreeNode) => void
  onDragOverNode: (e: React.DragEvent, node: FileTreeNode) => void
  onDragLeaveNode: (e: React.DragEvent, node: FileTreeNode) => void
  onDropNode: (e: React.DragEvent, node: FileTreeNode) => void
}

function TreeChevron({ expanded }: { expanded: boolean }): JSX.Element {
  return (
    <span className={`tree-chevron${expanded ? ' expanded' : ''}`} aria-hidden>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path
          d="M6 4.5L10 8L6 11.5"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  )
}

type TreeChildrenPhase = 'closed' | 'open' | 'animating'


function TreeChildren({ expanded, children }: { expanded: boolean; children: ReactNode }): JSX.Element {
  const outerRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const skipAnimRef = useRef(true)
  const prevChildCountRef = useRef(Children.count(children))
  const animSessionRef = useRef(0)
  const endSessionRef = useRef(0)
  const rafIdsRef = useRef<number[]>([])
  const [phase, setPhase] = useState<TreeChildrenPhase>(expanded ? 'open' : 'closed')
  const [animHeight, setAnimHeight] = useState(0)
  const [transitionHeight, setTransitionHeight] = useState(false)

  const measure = (): number => outerRef.current?.scrollHeight ?? innerRef.current?.scrollHeight ?? 0
  const childCount = Children.count(children)

  const cancelPendingFrames = (): void => {
    for (const id of rafIdsRef.current) cancelAnimationFrame(id)
    rafIdsRef.current = []
  }

  const scheduleFrame = (fn: () => void): void => {
    const id = requestAnimationFrame(() => {
      rafIdsRef.current = rafIdsRef.current.filter((x) => x !== id)
      fn()
    })
    rafIdsRef.current.push(id)
  }

  const runExpandAnimation = (session: number): void => {
    setTransitionHeight(true)
    setPhase('animating')
    setAnimHeight(0)
    scheduleFrame(() => {
      scheduleFrame(() => {
        if (animSessionRef.current !== session) return
        endSessionRef.current = session
        setAnimHeight(measure())
      })
    })
  }

  useLayoutEffect(() => {
    animSessionRef.current += 1
    const session = animSessionRef.current
    cancelPendingFrames()

    if (skipAnimRef.current) {
      skipAnimRef.current = false
      if (!expanded) {
        setPhase('closed')
        setTransitionHeight(false)
        return
      }
      if (childCount === 0) {
        setPhase('animating')
        setAnimHeight(0)
        setTransitionHeight(true)
        return
      }
      runExpandAnimation(session)
      return
    }

    if (expanded) {
      runExpandAnimation(session)
      return
    }

    
    const full = measure()
    setTransitionHeight(false)
    setPhase('animating')
    setAnimHeight(full)
    scheduleFrame(() => {
      if (animSessionRef.current !== session) return
      void outerRef.current?.offsetHeight
      setTransitionHeight(true)
      scheduleFrame(() => {
        if (animSessionRef.current !== session) return
        endSessionRef.current = session
        setAnimHeight(0)
      })
    })
  }, [expanded])

  
  useLayoutEffect(() => {
    const prev = prevChildCountRef.current
    prevChildCountRef.current = childCount
    if (!expanded || childCount === 0 || prev > 0) return

    animSessionRef.current += 1
    const session = animSessionRef.current
    cancelPendingFrames()
    runExpandAnimation(session)
  }, [childCount, expanded])

  useLayoutEffect(() => () => cancelPendingFrames(), [])

  const onTransitionEnd = (e: React.TransitionEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget || e.propertyName !== 'height' || phase !== 'animating') return
    if (endSessionRef.current !== animSessionRef.current) return
    setTransitionHeight(false)
    setPhase(expanded ? 'open' : 'closed')
  }

  const className = [
    'tree-children',
    phase === 'open' && 'is-open',
    phase === 'closed' && 'is-closed',
    phase === 'animating' && 'is-animating',
    phase === 'animating' && transitionHeight && 'is-transitioning-height'
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      ref={outerRef}
      className={className}
      style={phase === 'animating' ? { height: animHeight } : undefined}
      onTransitionEnd={onTransitionEnd}
    >
      <div ref={innerRef} className="tree-children-inner">
        {children}
      </div>
    </div>
  )
}

function TreeNode({
  node,
  depth,
  selected,
  onRowClick,
  onContextMenu,
  drag
}: {
  node: FileTreeNode
  depth: number
  selected: Set<string>
  onRowClick: (e: MouseEvent, node: FileTreeNode) => void
  onContextMenu: (e: MouseEvent, node: FileTreeNode) => void
  drag: DragProps
}): JSX.Element {
  const expanded = useWorkspaceStore((s) => s.expandedFolders.has(node.path))
  const isDir = node.type === 'directory'
  const isSelected = selected.has(node.path)
  const isDropTarget = drag.dragOverPath === node.path

  return (
    <>
      <div
        className={`tree-node${isSelected ? ' selected' : ''}${isDropTarget ? ' drop-target' : ''}`}
        style={{ paddingLeft: depth * 12 + 4 }}
        draggable
        onClick={(e) => onRowClick(e, node)}
        onContextMenu={(e) => onContextMenu(e, node)}
        onDragStart={(e) => drag.onDragStart(e, node)}
        onDragOver={(e) => drag.onDragOverNode(e, node)}
        onDragLeave={(e) => drag.onDragLeaveNode(e, node)}
        onDrop={(e) => drag.onDropNode(e, node)}
        title={node.path}
      >
        {isDir ? <TreeChevron expanded={expanded} /> : <span className="tree-chevron tree-chevron--spacer" aria-hidden />}
        <span className="label">
          <FileIcon name={node.name} isDir={isDir} expanded={expanded} />
          <span className="node-name">{node.name}</span>
        </span>
      </div>
      {isDir && (expanded || (node.children?.length ?? 0) > 0) && (
        <TreeChildren expanded={expanded}>
          {node.children?.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              selected={selected}
              onRowClick={onRowClick}
              onContextMenu={onContextMenu}
              drag={drag}
            />
          ))}
        </TreeChildren>
      )}
    </>
  )
}

export default function FileTree(): JSX.Element {
  const workspace = useWorkspaceStore((s) => s.workspace)
  const tree = useWorkspaceStore((s) => s.tree)
  const loading = useWorkspaceStore((s) => s.loading)
  const expandedFolders = useWorkspaceStore((s) => s.expandedFolders)
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace)
  const refreshTree = useWorkspaceStore((s) => s.refreshTree)
  const showIgnoredFiles = useUiStore((s) => s.showIgnoredFiles)
  const toggleShowIgnoredFiles = useUiStore((s) => s.toggleShowIgnoredFiles)

  const [menu, setMenu] = useState<MenuState | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const [clipboard, setClipboard] = useState<{ paths: string[]; mode: 'cut' | 'copy' } | null>(null)
  const [dragOverPath, setDragOverPath] = useState<string | null>(null)

  const flat = useMemo(() => flattenVisible(tree, expandedFolders), [tree, expandedFolders])

  
  const destDirOf = (node: FileTreeNode | null): string =>
    node ? (node.type === 'directory' ? node.path : dirname(node.path)) : workspace?.path ?? ''

  const onDragStart = (e: DragEvent, node: FileTreeNode): void => {
    const paths = selected.has(node.path) ? [...selected] : [node.path]
    e.dataTransfer.setData(DND_PATHS_MIME, JSON.stringify(paths))
    e.dataTransfer.effectAllowed = 'copyMove'
  }

  const onDragOverNode = (e: DragEvent, node: FileTreeNode): void => {
    if (!e.dataTransfer.types.includes(DND_PATHS_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move'
    setDragOverPath(node.type === 'directory' ? node.path : null)
  }

  const onDragLeaveNode = (_e: DragEvent, node: FileTreeNode): void => {
    if (dragOverPath === node.path) setDragOverPath(null)
  }

  const runDrop = async (paths: string[], destDir: string, copy: boolean): Promise<void> => {
    if (!destDir) return
    
    const filtered = paths.filter((p) => p !== destDir && (copy || dirname(p) !== destDir))
    if (filtered.length === 0) return
    const res = copy
      ? await useWorkspaceStore.getState().copyItems(filtered, destDir)
      : await useWorkspaceStore.getState().moveItems(filtered, destDir)
    if (!res.ok) await showError(res.error ?? '操作失败')
  }

  const onDropNode = (e: DragEvent, node: FileTreeNode): void => {
    const raw = e.dataTransfer.getData(DND_PATHS_MIME)
    if (!raw) return
    e.preventDefault()
    e.stopPropagation()
    setDragOverPath(null)
    try {
      void runDrop(JSON.parse(raw) as string[], destDirOf(node), e.ctrlKey)
    } catch {
      
    }
  }

  const onDropRoot = (e: DragEvent): void => {
    const raw = e.dataTransfer.getData(DND_PATHS_MIME)
    if (!raw || !workspace) return
    e.preventDefault()
    setDragOverPath(null)
    try {
      void runDrop(JSON.parse(raw) as string[], workspace.path, e.ctrlKey)
    } catch {
      
    }
  }

  const doPaste = async (destDir: string): Promise<void> => {
    if (!clipboard) return
    const res =
      clipboard.mode === 'cut'
        ? await useWorkspaceStore.getState().moveItems(clipboard.paths, destDir)
        : await useWorkspaceStore.getState().copyItems(clipboard.paths, destDir)
    if (clipboard.mode === 'cut' && res.ok) setClipboard(null)
    if (!res.ok) await showError(res.error ?? '粘贴失败')
  }

  const dragProps: DragProps = { dragOverPath, onDragStart, onDragOverNode, onDragLeaveNode, onDropNode }

  const selectSingle = (path: string): void => {
    setSelected(new Set([path]))
    setAnchor(path)
  }

  const runDelete = async (paths: string[]): Promise<void> => {
    if (paths.length === 0) return
    const ok = await useDialogStore.getState().confirm({
      title: '确认删除',
      message:
        paths.length === 1
          ? `确定要删除 "${basename(paths[0])}" 吗？此操作不可撤销。`
          : `确定要删除选中的 ${paths.length} 个项目吗？此操作不可撤销。`,
      confirmText: '删除',
      danger: true
    })
    if (!ok) return
    const res = await useWorkspaceStore.getState().deleteMany(paths)
    if (res.ok) {
      setSelected(new Set())
      setAnchor(null)
    }
    if (!res.ok) await showError(res.error ?? '删除失败')
  }

  const onRowClick = (e: MouseEvent, node: FileTreeNode): void => {
    
    if (e.shiftKey && anchor) {
      const ai = flat.findIndex((n) => n.path === anchor)
      const bi = flat.findIndex((n) => n.path === node.path)
      if (ai !== -1 && bi !== -1) {
        const [lo, hi] = ai < bi ? [ai, bi] : [bi, ai]
        setSelected(new Set(flat.slice(lo, hi + 1).map((n) => n.path)))
      } else {
        selectSingle(node.path)
      }
      return
    }
    
    if (e.ctrlKey || e.metaKey) {
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(node.path)) next.delete(node.path)
        else next.add(node.path)
        return next
      })
      setAnchor(node.path)
      return
    }
    
    selectSingle(node.path)
    if (node.type === 'directory') useWorkspaceStore.getState().toggleFolder(node.path)
    else void useEditorStore.getState().openFile(node.path, node.name)
  }

  const openContext = (e: MouseEvent, node: FileTreeNode | null): void => {
    e.preventDefault()
    e.stopPropagation()
    let sel = selected
    if (node && !selected.has(node.path)) {
      sel = new Set([node.path])
      selectSingle(node.path)
    }
    setMenu({ x: e.clientX, y: e.clientY, node, sel: [...sel] })
  }

  const buildItems = (node: FileTreeNode | null, sel: string[], rootPath: string): MenuItem[] => {
    if (!node) {
      return [
        { label: '新建文件', onClick: () => void promptNewFile(rootPath) },
        { label: '新建文件夹', onClick: () => void promptNewFolder(rootPath) },
        { separator: true },
        {
          label: '粘贴',
          disabled: !clipboard,
          onClick: () => void doPaste(rootPath)
        },
        { separator: true },
        { label: '刷新', onClick: () => void refreshTree() },
        {
          label: '在终端中打开',
          onClick: () => void useTerminalStore.getState().createSession(rootPath)
        },
        { label: '在资源管理器中显示', onClick: () => void window.lc.revealItem(rootPath) }
      ]
    }

    const multi = sel.length > 1 && sel.includes(node.path)
    const parentForNew = node.type === 'directory' ? node.path : dirname(node.path)
    const terminalCwd = node.type === 'directory' ? node.path : dirname(node.path)
    const pasteDir = node.type === 'directory' ? node.path : dirname(node.path)
    const deletePaths = multi ? sel : [node.path]
    const copyText = multi ? sel.join('\n') : node.path
    const cutCopyPaths = multi ? sel : [node.path]

    const common: MenuItem[] = [
      { label: '新建文件', disabled: multi, onClick: () => void promptNewFile(parentForNew) },
      { label: '新建文件夹', disabled: multi, onClick: () => void promptNewFolder(parentForNew) },
      { separator: true },
      {
        label: multi ? `剪切 (${sel.length})` : '剪切',
        onClick: () => setClipboard({ paths: cutCopyPaths, mode: 'cut' })
      },
      {
        label: multi ? `复制 (${sel.length})` : '复制',
        onClick: () => setClipboard({ paths: cutCopyPaths, mode: 'copy' })
      },
      {
        label: '粘贴',
        disabled: !clipboard,
        onClick: () => void doPaste(pasteDir)
      },
      { separator: true },
      {
        label: multi ? `复制路径 (${sel.length})` : '复制路径',
        onClick: () => void window.lc.clipboardWriteText(copyText)
      },
      { label: '在资源管理器中显示', disabled: multi, onClick: () => void window.lc.revealItem(node.path) },
      { separator: true },
      { label: '重命名', shortcut: 'F2', disabled: multi, onClick: () => void promptRename(node) },
      {
        label: multi ? `删除 (${sel.length} 项)` : '删除',
        shortcut: 'Del',
        danger: true,
        onClick: () => void runDelete(deletePaths)
      },
      { separator: true },
      {
        label: '在终端中打开',
        disabled: multi,
        onClick: () => void useTerminalStore.getState().createSession(terminalCwd)
      }
    ]

    if (node.type === 'file' && !multi) {
      const compareLeft = useEditorStore.getState().compareLeft
      return [
        {
          label: '打开',
          onClick: () => void useEditorStore.getState().openFile(node.path, node.name)
        },
        { separator: true },
        {
          label: '选择以进行比较',
          onClick: () => useEditorStore.getState().setCompareLeft(node.path)
        },
        {
          label: compareLeft ? `与 "${basename(compareLeft)}" 比较` : '与已选项比较',
          disabled: !compareLeft || compareLeft === node.path,
          onClick: () => void useEditorStore.getState().openDiff(compareLeft!, node.path)
        },
        { separator: true },
        ...common
      ]
    }
    return common
  }

  const onTreeKeyDown = (e: KeyboardEvent): void => {
    
    if (e.ctrlKey || e.metaKey) {
      if (e.key.toLowerCase() === 'x' && selected.size > 0) {
        e.preventDefault()
        setClipboard({ paths: [...selected], mode: 'cut' })
        return
      }
      if (e.key.toLowerCase() === 'c' && selected.size > 0) {
        e.preventDefault()
        setClipboard({ paths: [...selected], mode: 'copy' })
        return
      }
      if (e.key.toLowerCase() === 'v' && clipboard) {
        e.preventDefault()
        const target = anchor && selected.has(anchor) ? anchor : [...selected][0]
        const node = target ? findNode(tree, target) : null
        void doPaste(node ? destDirOf(node) : workspace?.path ?? '')
        return
      }
    }
    if (selected.size === 0) return
    if (e.key === 'F2') {
      const target = anchor && selected.has(anchor) ? anchor : [...selected][0]
      const node = findNode(tree, target)
      if (node) {
        e.preventDefault()
        void promptRename(node)
      }
    } else if (e.key === 'Delete') {
      e.preventDefault()
      void runDelete([...selected])
    } else if (e.key === 'Enter') {
      const target = anchor && selected.has(anchor) ? anchor : [...selected][0]
      const node = findNode(tree, target)
      if (!node) return
      e.preventDefault()
      if (node.type === 'file') void useEditorStore.getState().openFile(node.path, node.name)
      else useWorkspaceStore.getState().toggleFolder(node.path)
    }
  }

  return (
    <div className="sidebar">
      <div className="panel-header">
        <span>资源管理器</span>
        <span>
          {workspace && (
            <>
              <button
                className={`btn-ghost${showIgnoredFiles ? ' active' : ''}`}
                title={showIgnoredFiles ? '隐藏被忽略的文件' : '显示被忽略的文件（如 build/out）'}
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  toggleShowIgnoredFiles()
                  void refreshTree()
                }}
              >
                {showIgnoredFiles ? '👁' : '⦰'}
              </button>
              <button
                className="btn-ghost"
                title="刷新"
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void refreshTree()}
              >
                ⟳
              </button>
            </>
          )}
        </span>
      </div>

      {workspace && (
        <div className="workspace-name" title={workspace.path}>
          {workspace.name}
        </div>
      )}

      <div
        className="filetree"
        tabIndex={0}
        onKeyDown={onTreeKeyDown}
        onDragOver={(e) => {
          if (workspace && e.dataTransfer.types.includes(DND_PATHS_MIME)) {
            e.preventDefault()
            e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move'
          }
        }}
        onDrop={onDropRoot}
        onContextMenu={(e) => {
          
          if (workspace) openContext(e, null)
        }}
      >
        {!workspace ? (
          <div className="filetree-empty">
            <p className="filetree-empty-text">尚未打开工作区。</p>
            <button className="btn" type="button" onClick={() => void openWorkspace()}>
              打开文件夹
            </button>
          </div>
        ) : loading ? (
          <div className="empty-hint">加载中…</div>
        ) : tree.length === 0 ? (
          <div className="empty-hint">空文件夹。右键可新建文件。</div>
        ) : (
          tree.map((node) => (
            <TreeNode
              key={node.path}
              node={node}
              depth={0}
              selected={selected}
              onRowClick={onRowClick}
              onContextMenu={openContext}
              drag={dragProps}
            />
          ))
        )}
      </div>

      {menu && workspace && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={buildItems(menu.node, menu.sel, workspace.path)}
          onClose={() => setMenu(null)}
        />
      )}

      <ResizeHandle
        edge="right"
        title="拖动调整资源管理器宽度"
        getSize={() => useUiStore.getState().sidebarWidth}
        onResize={(w) => useUiStore.getState().setSidebarWidth(w)}
      />
    </div>
  )
}
