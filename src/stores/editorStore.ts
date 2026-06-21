import { create } from 'zustand'
import type { EditorTab } from '@/types'
import { detectLanguage } from '@/utils/language'
import { basename, isInside, dirname, pathsEqual } from '@/utils/path'
import { isPersistableTabPath } from '@/utils/session'
import { wasRecentLocalWrite, noteLocalWrite } from '@/utils/localWrites'
import { useDialogStore } from '@/stores/dialogStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { formatDocument } from '@/components/Editor/editorBridge'
import { syncEditorDirtyPaths } from '@/utils/syncEditorSnapshot'

let dirtySyncTimer: ReturnType<typeof setTimeout> | undefined
function scheduleDirtySync(): void {
  if (dirtySyncTimer) clearTimeout(dirtySyncTimer)
  dirtySyncTimer = setTimeout(() => {
    dirtySyncTimer = undefined
    syncEditorDirtyPaths()
  }, 80)
}


let restoreGeneration = 0
let restoringSession = false

export function isRestoringSession(): boolean {
  return restoringSession
}

export interface RevealRequest {
  path: string
  line: number
  col: number
}

interface EditorState {
  tabs: EditorTab[]
  activeTabPath: string | null
  
  revealRequest: RevealRequest | null
  
  compareLeft: string | null

  openFile: (path: string, name: string) => Promise<void>
  
  openFileAt: (path: string, name: string, line: number, col: number) => Promise<void>
  clearReveal: () => void
  openTab: (tab: EditorTab) => void
  closeTab: (path: string) => void
  requestCloseTab: (path: string) => Promise<void>
  closeOthers: (path: string) => Promise<void>
  closeToRight: (path: string) => Promise<void>
  closeSaved: () => Promise<void>
  closeAll: () => Promise<void>
  
  confirmCloseAll: () => Promise<boolean>
  setActiveTab: (path: string) => void
  updateTabContent: (path: string, content: string) => void
  saveActiveTab: () => Promise<void>
  saveTab: (path: string) => Promise<void>
  setCursor: (path: string, line: number, col: number) => void
  closeTabsUnder: (path: string) => void
  renamePath: (oldPath: string, newPath: string) => void
  
  moveTab: (sourcePath: string, targetPath: string) => void
  
  togglePin: (path: string) => void
  
  newUntitled: () => void
  
  setCompareLeft: (path: string) => void
  
  openDiff: (left: string, right: string) => Promise<void>
  
  reloadFromDisk: (paths: string[]) => Promise<void>
  
  restoreTabs: (paths: string[], activePath: string | null) => Promise<void>
  
  invalidateTabRestore: () => void
  
  closeEphemeralTabs: () => Promise<void>
}

export const useEditorStore = create<EditorState>((set, get) => ({
  tabs: [],
  activeTabPath: null,
  revealRequest: null,
  compareLeft: null,

  openFile: async (path, name) => {
    const existing = get().tabs.find((t) => t.path === path)
    if (existing) {
      set({ activeTabPath: path })
      return
    }

    const res = await window.lc.readFileSafe(path)
    if (!res.ok) {
      void useDialogStore.getState().confirm({
        title: '无法打开文件',
        message: `读取 "${name}" 失败：${res.error ?? '未知错误'}`,
        confirmText: '知道了',
        cancelText: '关闭'
      })
      return
    }

    const human = (n?: number): string =>
      n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`

    if (res.tooLarge) {
      void useDialogStore.getState().confirm({
        title: '文件过大',
        message: `"${name}"（${human(res.size)}）超过可打开上限，已阻止以避免卡顿。`,
        confirmText: '知道了',
        cancelText: '关闭'
      })
      return
    }

    if (res.kind === 'binary') {
      void useDialogStore.getState().confirm({
        title: '无法以文本打开',
        message: `"${name}" 是二进制文件（${human(res.size)}），无法在编辑器中显示。`,
        confirmText: '知道了',
        cancelText: '关闭'
      })
      return
    }

    if (res.kind === 'image') {
      const tab: EditorTab = {
        path,
        name,
        content: '',
        dirty: false,
        language: 'image',
        kind: 'image',
        dataUrl: res.dataUrl,
        size: res.size
      }
      set((s) =>
        s.tabs.some((t) => t.path === path)
          ? { activeTabPath: path }
          : { tabs: [tab, ...s.tabs], activeTabPath: path }
      )
      return
    }

    const tab: EditorTab = {
      path,
      name,
      content: res.content ?? '',
      savedContent: res.content ?? '',
      dirty: false,
      language: detectLanguage(path),
      kind: 'text',
      encoding: res.encoding ?? 'utf8',
      size: res.size
    }
    set((s) =>
      s.tabs.some((t) => t.path === path)
        ? { activeTabPath: path }
        : { tabs: [tab, ...s.tabs], activeTabPath: path }
    )
  },

  openFileAt: async (path, name, line, col) => {
    await get().openFile(path, name)
    
    const tab = get().tabs.find((t) => t.path === path)
    if (tab && tab.kind === 'text') set({ revealRequest: { path, line, col } })
  },

  clearReveal: () => set({ revealRequest: null }),

  moveTab: (sourcePath, targetPath) => {
    if (sourcePath === targetPath) return
    set((s) => {
      const tabs = [...s.tabs]
      const from = tabs.findIndex((t) => t.path === sourcePath)
      let to = tabs.findIndex((t) => t.path === targetPath)
      if (from === -1 || to === -1) return s
      const [moved] = tabs.splice(from, 1)
      to = tabs.findIndex((t) => t.path === targetPath)
      tabs.splice(to, 0, moved)
      return { tabs }
    })
  },

  togglePin: (path) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.path === path ? { ...t, pinned: !t.pinned } : t))
    }))
  },

  setCompareLeft: (path) => set({ compareLeft: path }),

  openDiff: async (left, right) => {
    const diffPath = `diff:${left}::${right}`
    if (get().tabs.some((t) => t.path === diffPath)) {
      set({ activeTabPath: diffPath })
      return
    }
    const [a, b] = await Promise.all([window.lc.readFileSafe(left), window.lc.readFileSafe(right)])
    if (!a.ok || a.kind !== 'text' || !b.ok || b.kind !== 'text') {
      void useDialogStore.getState().confirm({
        title: '无法比较',
        message: '只能对比两个文本文件。',
        confirmText: '知道了',
        cancelText: '关闭'
      })
      return
    }
    const tab: EditorTab = {
      path: diffPath,
      name: `${basename(left)} ↔ ${basename(right)}`,
      content: '',
      dirty: false,
      language: detectLanguage(right),
      kind: 'diff',
      diffOriginal: a.content ?? '',
      diffModified: b.content ?? ''
    }
    set((s) => ({ tabs: [tab, ...s.tabs], activeTabPath: diffPath }))
  },

  newUntitled: () => {
    const existing = get().tabs.filter((t) => t.untitled)
    let n = 1
    while (existing.some((t) => t.name === `Untitled-${n}`)) n++
    const name = `Untitled-${n}`
    const tab: EditorTab = {
      path: `untitled:${name}`,
      name,
      content: '',
      dirty: true,
      language: 'plaintext',
      kind: 'text',
      encoding: 'utf8',
      untitled: true
    }
    set((s) => ({ tabs: [tab, ...s.tabs], activeTabPath: tab.path }))
  },

  openTab: (tab) => {
    set((s) => {
      if (s.tabs.some((t) => t.path === tab.path)) {
        return { activeTabPath: tab.path }
      }
      return { tabs: [tab, ...s.tabs], activeTabPath: tab.path }
    })
  },

  closeTab: (path) => {
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.path === path)
      if (idx === -1) return s
      const tabs = s.tabs.filter((t) => t.path !== path)
      let activeTabPath = s.activeTabPath
      if (activeTabPath === path) {
        const next = tabs[idx] ?? tabs[idx - 1] ?? null
        activeTabPath = next ? next.path : null
      }
      return { tabs, activeTabPath }
    })
  },

  
  requestCloseTab: async (path) => {
    const tab = get().tabs.find((t) => t.path === path)
    if (!tab) return
    if (!tab.dirty) {
      get().closeTab(path)
      return
    }
    const choice = await useDialogStore.getState().choose({
      title: '未保存的更改',
      message: `是否保存对 "${tab.name}" 的更改？`,
      buttons: [
        { key: 'save', label: '保存', primary: true },
        { key: 'discard', label: '不保存', danger: true },
        { key: 'cancel', label: '取消' }
      ]
    })
    if (choice === 'cancel' || choice === null) return
    if (choice === 'save') {
      await get().saveTab(path)
      
      const after = get().tabs.find((t) => t.path === path)
      if (after?.dirty) return
    }
    get().closeTab(path)
  },

  
  
  
  closeOthers: async (path) => {
    const others = get().tabs.filter((t) => t.path !== path && !t.pinned).map((t) => t.path)
    for (const p of others) await get().requestCloseTab(p)
  },

  closeToRight: async (path) => {
    const tabs = get().tabs
    const idx = tabs.findIndex((t) => t.path === path)
    if (idx === -1) return
    const right = tabs.slice(idx + 1).filter((t) => !t.pinned).map((t) => t.path)
    for (const p of right) await get().requestCloseTab(p)
  },

  closeSaved: async () => {
    const saved = get().tabs.filter((t) => !t.dirty && !t.pinned).map((t) => t.path)
    for (const p of saved) await get().requestCloseTab(p)
  },

  closeAll: async () => {
    const all = get().tabs.filter((t) => !t.pinned).map((t) => t.path)
    for (const p of all) await get().requestCloseTab(p)
  },

  
  confirmCloseAll: async () => {
    const dirty = get().tabs.filter((t) => t.dirty)
    if (dirty.length === 0) return true
    const choice = await useDialogStore.getState().choose({
      title: '未保存的更改',
      message:
        dirty.length === 1
          ? `是否保存对 "${dirty[0].name}" 的更改？`
          : `有 ${dirty.length} 个文件包含未保存的更改，是否保存？`,
      buttons: [
        { key: 'save', label: '保存全部', primary: true },
        { key: 'discard', label: '不保存', danger: true },
        { key: 'cancel', label: '取消' }
      ]
    })
    if (choice === 'cancel' || choice === null) return false
    if (choice === 'discard') return true
    
    for (const tab of dirty) await get().saveTab(tab.path)
    return get().tabs.every((t) => !t.dirty)
  },

  setActiveTab: (path) => set({ activeTabPath: path }),

  updateTabContent: (path, content) => {
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.path !== path) return t
        if (t.untitled) return { ...t, content, dirty: true }
        const baseline = t.savedContent ?? t.content
        return { ...t, content, dirty: content !== baseline }
      })
    }))
    scheduleDirtySync()
  },

  saveActiveTab: async () => {
    const path = get().activeTabPath
    if (path) await get().saveTab(path)
  },

  saveTab: async (path) => {
    let tab = get().tabs.find((t) => t.path === path)
    if (!tab) return

    
    if (tab.untitled) {
      const res = await window.lc.saveFileAs(tab.name, tab.content)
      if (!res.ok || !res.path) {
        if (res.error) {
          void useDialogStore.getState().confirm({
            title: '保存失败',
            message: res.error,
            confirmText: '知道了',
            cancelText: '关闭'
          })
        }
        return
      }
      const newPath = res.path
      const newName = basename(newPath)
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.path === path
            ? {
                ...t,
                path: newPath,
                name: newName,
                untitled: false,
                dirty: false,
                savedContent: t.content,
                language: detectLanguage(newPath)
              }
            : t
        ),
        activeTabPath: s.activeTabPath === path ? newPath : s.activeTabPath
      }))
      return
    }

    if (!tab.dirty) return
    
    if (useSettingsStore.getState().formatOnSave && tab.kind === 'text' && path === get().activeTabPath) {
      await formatDocument()
      tab = get().tabs.find((t) => t.path === path) ?? tab
    }
    try {
      await window.lc.writeFile(tab.path, tab.content, tab.encoding ?? 'utf8')
      noteLocalWrite(tab.path)
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.path === path ? { ...t, dirty: false, savedContent: t.content } : t
        )
      }))
      scheduleDirtySync()
    } catch (e) {
      void useDialogStore.getState().confirm({
        title: '保存失败',
        message: `无法保存 "${tab.name}"：${e instanceof Error ? e.message : '未知错误'}`,
        confirmText: '知道了',
        cancelText: '关闭'
      })
    }
  },

  setCursor: (path, line, col) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.path === path ? { ...t, cursorLine: line, cursorCol: col } : t
      )
    }))
  },

  
  closeTabsUnder: (path) => {
    set((s) => {
      const affected = (p: string): boolean => p === path || isInside(p, path)
      if (!s.tabs.some((t) => affected(t.path))) {
        return s
      }
      const tabs = s.tabs.filter((t) => !affected(t.path))
      let activeTabPath = s.activeTabPath
      if (activeTabPath && affected(activeTabPath)) {
        activeTabPath = tabs.length ? tabs[tabs.length - 1].path : null
      }
      return { tabs, activeTabPath }
    })
  },

  
  
  reloadFromDisk: async (paths) => {
    const eventPaths = [...new Set(paths)]
    const eventSet = new Set(eventPaths)

    
    for (const tab of get().tabs.filter((t) => isPersistableTabPath(t.path))) {
      if (tab.dirty || eventSet.has(tab.path)) continue
      const res = await window.lc.readFileSafe(tab.path)
      if (res.ok) continue
      const dir = dirname(tab.path)
      const newcomers = eventPaths.filter(
        (p) =>
          p !== tab.path &&
          dirname(p) === dir &&
          !get().tabs.some((t) => pathsEqual(t.path, p))
      )
      if (newcomers.length === 1) {
        get().renamePath(tab.path, newcomers[0])
      }
    }

    const targets = get().tabs.filter(
      (t) =>
        isPersistableTabPath(t.path) &&
        eventPaths.some((p) => pathsEqual(p, t.path))
    )
    for (const tab of targets) {
      if (tab.dirty || wasRecentLocalWrite(tab.path)) continue
      const res = await window.lc.readFileSafe(tab.path)
      if (!res.ok) {
        get().closeTab(tab.path)
        continue
      }
      if (res.kind === 'text' && res.content !== undefined) {
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.path === tab.path
              ? {
                  ...t,
                  content: res.content!,
                  savedContent: res.content!,
                  encoding: res.encoding ?? t.encoding,
                  size: res.size
                }
              : t
          )
        }))
      } else if (res.kind === 'image' && res.dataUrl) {
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.path === tab.path ? { ...t, dataUrl: res.dataUrl, size: res.size } : t
          )
        }))
      }
    }
  },

  invalidateTabRestore: () => {
    restoreGeneration++
    restoringSession = false
  },

  closeEphemeralTabs: async () => {
    const ephemeral = get().tabs.filter((t) => t.untitled || t.kind === 'diff')
    for (const t of ephemeral) {
      if (t.dirty) await get().requestCloseTab(t.path)
      else get().closeTab(t.path)
    }
  },

  
  restoreTabs: async (paths, activePath) => {
    const gen = ++restoreGeneration
    restoringSession = true
    try {
      const uniquePaths = [...new Set(paths.filter(isPersistableTabPath))]
      for (const path of uniquePaths) {
        if (gen !== restoreGeneration) return
        if (get().tabs.some((t) => t.path === path)) continue
        const res = await window.lc.readFileSafe(path)
        if (gen !== restoreGeneration) return
        if (!res.ok || res.tooLarge || res.kind === 'binary') continue
        const name = basename(path)
        if (res.kind === 'image' && res.dataUrl) {
          const tab: EditorTab = {
            path,
            name,
            content: '',
            dirty: false,
            language: 'image',
            kind: 'image',
            dataUrl: res.dataUrl,
            size: res.size
          }
          set((s) =>
            s.tabs.some((t) => t.path === path) ? s : { tabs: [...s.tabs, tab] }
          )
        } else if (res.kind === 'text') {
          const tab: EditorTab = {
            path,
            name,
            content: res.content ?? '',
            savedContent: res.content ?? '',
            dirty: false,
            language: detectLanguage(path),
            kind: 'text',
            encoding: res.encoding ?? 'utf8',
            size: res.size
          }
          set((s) =>
            s.tabs.some((t) => t.path === path) ? s : { tabs: [...s.tabs, tab] }
          )
        }
      }
      if (gen !== restoreGeneration) return
      const exists =
        activePath &&
        isPersistableTabPath(activePath) &&
        get().tabs.some((t) => t.path === activePath)
      set({
        activeTabPath: exists ? activePath : get().tabs[get().tabs.length - 1]?.path ?? null
      })
    } finally {
      if (gen === restoreGeneration) restoringSession = false
    }
  },

  
  renamePath: (oldPath, newPath) => {
    set((s) => {
      const remap = (p: string): string | null => {
        if (p === oldPath) return newPath
        if (isInside(p, oldPath)) return newPath + p.slice(oldPath.length)
        return null
      }
      let changed = false
      const tabs = s.tabs.map((t) => {
        const np = remap(t.path)
        if (np === null) return t
        changed = true
        return { ...t, path: np, name: basename(np), language: detectLanguage(np) }
      })
      if (!changed) return s
      const newActive = s.activeTabPath ? remap(s.activeTabPath) : null
      return {
        tabs,
        activeTabPath: newActive ?? s.activeTabPath
      }
    })
  }
}))
