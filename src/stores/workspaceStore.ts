import { create } from 'zustand'
import type { FileTreeNode, OpResult, Workspace } from '@/types'
import { useEditorStore } from '@/stores/editorStore'
import { isInside, dirname } from '@/utils/path'
import { restartWorkspaceLsp, startInitialLsp, stopAllLsp } from '@/lsp/registry'
import { addRecentWorkspace, loadSession, saveSession, isPersistableTabPath } from '@/utils/session'
import { appStorageKey } from '@shared/appConfig'
import { useUiStore } from '@/stores/uiStore'

const STORAGE_KEY = appStorageKey('workspace')

function syncAgentWorkspace(workspaceId: string | null): void {
  void import('@/stores/agentStore').then(({ useAgentStore }) => {
    void useAgentStore.getState().setWorkspace(workspaceId)
  })
  void import('@/stores/buildStore').then(({ useBuildStore }) => {
    void useBuildStore.getState().refresh(workspaceId)
  })
}

interface WorkspaceState {
  workspace: Workspace | null

  lastWorkspace: Workspace | null
  tree: FileTreeNode[]
  expandedFolders: Set<string>
  loading: boolean

  init: () => Promise<void>

  setLastWorkspace: (ws: Workspace | null) => void
  activateWorkspace: () => Promise<void>
  openWorkspace: () => Promise<void>
  openWorkspacePath: (ws: Workspace) => Promise<void>
  closeWorkspace: () => void
  refreshTree: () => Promise<void>
  
  saveCurrentSession: () => void

  toggleFolder: (path: string) => void
  expandFolder: (path: string) => void
  collapseFolder: (path: string) => void

  createFile: (parentPath: string, name: string) => Promise<OpResult>
  createFolder: (parentPath: string, name: string) => Promise<OpResult>
  deleteItem: (node: FileTreeNode) => Promise<OpResult>
  deleteMany: (paths: string[]) => Promise<OpResult>
  renameItem: (oldPath: string, newName: string) => Promise<OpResult>
  moveItems: (paths: string[], destDir: string) => Promise<OpResult>
  copyItems: (paths: string[], destDir: string) => Promise<OpResult>
}

function persist(ws: Workspace | null): void {
  try {
    if (ws) localStorage.setItem(STORAGE_KEY, JSON.stringify(ws))
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    
  }
}


let initPromise: Promise<void> | null = null

let refreshGeneration = 0

function findNodeInTree(nodes: FileTreeNode[], path: string): FileTreeNode | null {
  for (const n of nodes) {
    if (n.path === path) return n
    if (n.children) {
      const found = findNodeInTree(n.children, path)
      if (found) return found
    }
  }
  return null
}


function preserveCollapsedSubtrees(
  newNodes: FileTreeNode[],
  oldNodes: FileTreeNode[] | undefined,
  expandedPaths: Set<string>
): FileTreeNode[] {
  if (!oldNodes?.length) return newNodes

  const oldByPath = new Map<string, FileTreeNode>()
  const indexOld = (nodes: FileTreeNode[]): void => {
    for (const n of nodes) {
      oldByPath.set(n.path, n)
      if (n.children) indexOld(n.children)
    }
  }
  indexOld(oldNodes)

  const merge = (nodes: FileTreeNode[]): FileTreeNode[] =>
    nodes.map((n) => {
      if (n.type !== 'directory') return n
      const old = oldByPath.get(n.path)
      if (!expandedPaths.has(n.path) && old?.children?.length) {
        return { ...n, children: old.children }
      }
      if (n.children) return { ...n, children: merge(n.children) }
      return n
    })

  return merge(newNodes)
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspace: null,
  lastWorkspace: null,
  tree: [],
  expandedFolders: new Set<string>(),
  loading: false,

  init: async () => {
    if (initPromise) return initPromise
    initPromise = (async () => {
      let saved: Workspace | null = null
      try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (raw) saved = JSON.parse(raw) as Workspace
      } catch {
        saved = null
      }
      if (!saved?.path) {
        syncAgentWorkspace(null)
        return
      }

      const pathExists = await window.lc.exists(saved.path)
      if (!pathExists) {
        persist(null)
        syncAgentWorkspace(null)
        return
      }


      set({ lastWorkspace: saved })
    })().catch((err) => {
      initPromise = null
      throw err
    })
    return initPromise
  },

  setLastWorkspace: (ws) => set({ lastWorkspace: ws }),

  activateWorkspace: async () => {
    if (get().workspace) return
    const saved = get().lastWorkspace
    if (!saved?.path) return

    const session = loadSession(saved.path)
    const expanded = new Set(session?.expanded ?? [])
    set({ workspace: saved, loading: true, expandedFolders: expanded })
    syncAgentWorkspace(saved.path)
    const tree = await window.lc.tree(saved.path, [...expanded], useUiStore.getState().showIgnoredFiles)
    set({ tree, loading: false })
    void window.lc.watch(saved.path)
    addRecentWorkspace(saved)
    if (session && session.openPaths.length > 0) {
      await useEditorStore.getState().restoreTabs(session.openPaths, session.activePath)
    }
    startInitialLsp()
  },

  openWorkspace: async () => {
    const ws = await window.lc.openFolder()
    if (!ws) return
    await get().openWorkspacePath(ws)
  },

  openWorkspacePath: async (ws) => {
    const editor = useEditorStore.getState()
    editor.invalidateTabRestore()

    
    const prev = get().workspace
    if (prev) {
      get().saveCurrentSession()
      editor.closeTabsUnder(prev.path)
      await editor.closeEphemeralTabs()
    }

    const session = loadSession(ws.path)
    const expanded = new Set(session?.expanded ?? [])
    set({ workspace: ws, lastWorkspace: ws, loading: true, expandedFolders: expanded })
    persist(ws)
    syncAgentWorkspace(ws.path)
    addRecentWorkspace(ws)
    const tree = await window.lc.tree(ws.path, [...expanded], useUiStore.getState().showIgnoredFiles)
    set({ tree, loading: false })
    void window.lc.watch(ws.path)
    if (session && session.openPaths.length > 0) {
      await editor.restoreTabs(session.openPaths, session.activePath)
    }
    restartWorkspaceLsp()
  },

  saveCurrentSession: () => {
    const ws = get().workspace
    if (!ws) return
    const editor = useEditorStore.getState()
    const persistable = editor.tabs.filter((t) => isPersistableTabPath(t.path))
    const activePath =
      editor.activeTabPath && isPersistableTabPath(editor.activeTabPath)
        ? editor.activeTabPath
        : null
    saveSession(ws.path, {
      openPaths: [...new Set(persistable.map((t) => t.path))],
      activePath,
      expanded: [...get().expandedFolders]
    })
  },

  closeWorkspace: () => {
    
    const root = get().workspace
    const editor = useEditorStore.getState()
    editor.invalidateTabRestore()
    if (root) {
      get().saveCurrentSession()
      editor.closeTabsUnder(root.path)
      void editor.closeEphemeralTabs()
    }
    set({ workspace: null, tree: [], expandedFolders: new Set() })
    persist(null)
    syncAgentWorkspace(null)
    void window.lc.unwatch()
    stopAllLsp()
  },

  refreshTree: async () => {
    const ws = get().workspace
    if (!ws) return
    const gen = ++refreshGeneration
    const expandedPaths = new Set(get().expandedFolders)
    const oldTree = get().tree
    const tree = await window.lc.tree(ws.path, [...expandedPaths], useUiStore.getState().showIgnoredFiles)
    if (gen !== refreshGeneration) return
    set({ tree: preserveCollapsedSubtrees(tree, oldTree, expandedPaths) })
  },

  toggleFolder: (path) => {
    const wasExpanded = get().expandedFolders.has(path)
    set((s) => {
      const next = new Set(s.expandedFolders)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return { expandedFolders: next }
    })
    
    if (!wasExpanded) {
      const cached = findNodeInTree(get().tree, path)
      if (!cached?.children?.length) void get().refreshTree()
    }
  },

  expandFolder: (path) => {
    set((s) => {
      if (s.expandedFolders.has(path)) return s
      const next = new Set(s.expandedFolders)
      next.add(path)
      return { expandedFolders: next }
    })
  },

  collapseFolder: (path) => {
    set((s) => {
      if (!s.expandedFolders.has(path)) return s
      const next = new Set(s.expandedFolders)
      next.delete(path)
      return { expandedFolders: next }
    })
  },

  createFile: async (parentPath, name) => {
    const res = await window.lc.createFile(parentPath, name)
    if (res.ok) {
      get().expandFolder(parentPath)
      await get().refreshTree()
      if (res.path) await useEditorStore.getState().openFile(res.path, name)
    }
    return res
  },

  createFolder: async (parentPath, name) => {
    const res = await window.lc.createFolder(parentPath, name)
    if (res.ok) {
      get().expandFolder(parentPath)
      await get().refreshTree()
    }
    return res
  },

  deleteItem: async (node) => {
    const res = await window.lc.deleteItem(node.path)
    if (res.ok) {
      useEditorStore.getState().closeTabsUnder(node.path)
      
      set((s) => {
        const next = new Set<string>()
        for (const p of s.expandedFolders) {
          if (p === node.path || isInside(p, node.path)) continue
          next.add(p)
        }
        return { expandedFolders: next }
      })
      await get().refreshTree()
    }
    return res
  },

  deleteMany: async (paths) => {
    
    const top = paths.filter((p) => !paths.some((q) => q !== p && isInside(p, q)))
    if (top.length === 0) return { ok: true }

    const results = await Promise.all(top.map((p) => window.lc.deleteItem(p)))
    const okPaths = top.filter((_, i) => results[i].ok)

    if (okPaths.length) {
      const editor = useEditorStore.getState()
      okPaths.forEach((p) => editor.closeTabsUnder(p))
      set((s) => {
        const next = new Set<string>()
        for (const ep of s.expandedFolders) {
          if (okPaths.some((p) => ep === p || isInside(ep, p))) continue
          next.add(ep)
        }
        return { expandedFolders: next }
      })
      await get().refreshTree()
    }

    const failed = results.filter((r) => !r.ok)
    return { ok: failed.length === 0, error: failed[0]?.error }
  },

  moveItems: async (paths, destDir) => {
    
    const top = paths.filter((p) => !paths.some((q) => q !== p && isInside(p, q)))
    let firstError: string | undefined
    for (const src of top) {
      if (dirname(src) === destDir) continue 
      const res = await window.lc.moveItem(src, destDir)
      if (res.ok && res.newPath) {
        useEditorStore.getState().renamePath(src, res.newPath)
      } else if (!res.ok && !firstError) {
        firstError = res.error
      }
    }
    get().expandFolder(destDir)
    await get().refreshTree()
    return { ok: !firstError, error: firstError }
  },

  copyItems: async (paths, destDir) => {
    const top = paths.filter((p) => !paths.some((q) => q !== p && isInside(p, q)))
    let firstError: string | undefined
    for (const src of top) {
      const res = await window.lc.copyItem(src, destDir)
      if (!res.ok && !firstError) firstError = res.error
    }
    get().expandFolder(destDir)
    await get().refreshTree()
    return { ok: !firstError, error: firstError }
  },

  renameItem: async (oldPath, newName) => {
    const res = await window.lc.renameItem(oldPath, newName)
    if (res.ok && res.newPath) {
      const newPath = res.newPath
      useEditorStore.getState().renamePath(oldPath, newPath)
      
      set((s) => {
        const next = new Set<string>()
        for (const p of s.expandedFolders) {
          if (p === oldPath) next.add(newPath)
          else if (isInside(p, oldPath)) next.add(newPath + p.slice(oldPath.length))
          else next.add(p)
        }
        return { expandedFolders: next }
      })
      await get().refreshTree()
    }
    return res
  }
}))
