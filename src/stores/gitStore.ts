import { create } from 'zustand'
import type {
  GitStatus,
  GitFileChange,
  GitFileStatus
} from '@shared/gitTypes'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useEditorStore } from '@/stores/editorStore'
import { useDialogStore } from '@/stores/dialogStore'
import { toast } from '@/stores/toastStore'
import { basename } from '@/utils/path'
import type { EditorTab } from '@/types'

interface GitState {
  status: GitStatus | null
  loading: boolean
  busy: boolean
  message: string
  generating: boolean
  amend: boolean
  lastError: string | null

  setMessage: (m: string) => void
  setAmend: (v: boolean) => void
  refresh: () => Promise<void>
  openDiff: (change: GitFileChange) => Promise<void>
  stage: (change: GitFileChange) => Promise<void>
  unstage: (change: GitFileChange) => Promise<void>
  stageAll: () => Promise<void>
  unstageAll: () => Promise<void>
  discard: (change: GitFileChange) => Promise<void>
  commit: () => Promise<void>
  generateMessage: () => Promise<void>
  push: () => Promise<void>
  pull: () => Promise<void>
  switchBranch: () => Promise<void>
}

function cwd(): string | null {
  return useWorkspaceStore.getState().workspace?.path ?? null
}

let refreshTimer: ReturnType<typeof setTimeout> | undefined

export const useGitStore = create<GitState>((set, get) => ({
  status: null,
  loading: false,
  busy: false,
  message: '',
  generating: false,
  amend: false,
  lastError: null,

  setMessage: (m) => set({ message: m }),
  setAmend: (v) => set({ amend: v }),

  refresh: async () => {
    const root = cwd()
    if (!root) {
      set({ status: null, loading: false })
      return
    }
    set({ loading: true })
    try {
      const status = await window.lc.git.status(root)
      set({ status, loading: false })
    } catch (e) {
      set({ loading: false, lastError: e instanceof Error ? e.message : '获取状态失败' })
    }
  },

  openDiff: async (change) => {
    const root = cwd()
    if (!root) return
    
    if (change.status === 'untracked') {
      await useEditorStore.getState().openFile(change.path, basename(change.path))
      return
    }
    const res = await window.lc.git.diff(root, change.path, change.staged)
    if (!res.ok) {
      toast.error(res.error ?? '无法获取差异')
      return
    }
    const label = `${basename(change.displayPath)} (${change.staged ? '已暂存' : '工作区'})`
    const diffPath = `gitdiff:${change.staged ? 'staged' : 'work'}:${change.path}`
    const tab: EditorTab = {
      path: diffPath,
      name: label,
      content: '',
      dirty: false,
      language: res.language ?? 'plaintext',
      kind: 'diff',
      diffOriginal: res.original,
      diffModified: res.modified
    }
    
    const editor = useEditorStore.getState()
    if (editor.tabs.some((t) => t.path === diffPath)) {
      editor.closeTab(diffPath)
    }
    editor.openTab(tab)
  },

  stage: async (change) => {
    const root = cwd()
    if (!root) return
    const res = await window.lc.git.stage(root, [change.path])
    if (!res.ok) toast.error(res.error ?? '暂存失败')
    await get().refresh()
  },

  unstage: async (change) => {
    const root = cwd()
    if (!root) return
    const res = await window.lc.git.unstage(root, [change.path])
    if (!res.ok) toast.error(res.error ?? '取消暂存失败')
    await get().refresh()
  },

  stageAll: async () => {
    const root = cwd()
    if (!root) return
    const res = await window.lc.git.stageAll(root)
    if (!res.ok) toast.error(res.error ?? '暂存失败')
    await get().refresh()
  },

  unstageAll: async () => {
    const root = cwd()
    if (!root) return
    const res = await window.lc.git.unstageAll(root)
    if (!res.ok) toast.error(res.error ?? '取消暂存失败')
    await get().refresh()
  },

  discard: async (change) => {
    const root = cwd()
    if (!root) return
    const ok = await useDialogStore.getState().confirm({
      title: '放弃更改',
      message:
        change.status === 'untracked'
          ? `将删除未跟踪文件 "${change.displayPath}"，此操作不可撤销。是否继续？`
          : `将放弃 "${change.displayPath}" 的全部本地更改，恢复到上次提交的状态，此操作不可撤销。是否继续？`,
      confirmText: '放弃更改',
      danger: true
    })
    if (!ok) return
    const res = await window.lc.git.discard(root, { path: change.path, status: change.status })
    if (!res.ok) toast.error(res.error ?? '放弃更改失败')
    await get().refresh()
  },

  commit: async () => {
    const root = cwd()
    if (!root) return
    const { message, amend, status } = get()
    const hasStaged = (status?.staged.length ?? 0) > 0
    const hasUnstaged = (status?.unstaged.length ?? 0) > 0
    if (!hasStaged && !hasUnstaged && !amend) {
      toast.warn('没有可提交的更改')
      return
    }
    if (!message.trim() && !amend) {
      toast.warn('请输入提交信息')
      return
    }
    set({ busy: true })
    try {
      
      if (!hasStaged && hasUnstaged) {
        const ok = await useDialogStore.getState().confirm({
          title: '提交全部更改',
          message: '当前没有已暂存的更改，是否暂存全部更改并提交？',
          confirmText: '暂存全部并提交'
        })
        if (!ok) return
        const staged = await window.lc.git.stageAll(root)
        if (!staged.ok) {
          toast.error(staged.error ?? '暂存失败')
          return
        }
      }
      const res = await window.lc.git.commit(root, message, amend)
      if (!res.ok) {
        toast.error(res.error ?? '提交失败')
        return
      }
      toast.info(`已提交${res.hash ? ` (${res.hash})` : ''}`)
      set({ message: '', amend: false })
      await get().refresh()
    } finally {
      set({ busy: false })
    }
  },

  generateMessage: async () => {
    const root = cwd()
    if (!root) return
    if (!get().status?.staged.length) {
      toast.warn('请先暂存要提交的更改')
      return
    }
    set({ generating: true })
    try {
      const res = await window.lc.git.generateMessage(root)
      if (!res.ok || !res.message) {
        toast.error(res.error ?? '生成失败')
        return
      }
      set({ message: res.message })
    } finally {
      set({ generating: false })
    }
  },

  push: async () => {
    const root = cwd()
    if (!root) return
    const { status } = get()
    const target = status?.hasUpstream
      ? `远程跟踪分支`
      : `新的远程分支 origin/${status?.branch ?? '当前分支'}`
    const ok = await useDialogStore.getState().confirm({
      title: '推送到远程',
      message: `将把本地提交推送到 ${target}。是否继续？`,
      confirmText: '推送'
    })
    if (!ok) return
    set({ busy: true })
    try {
      const res = await window.lc.git.push(root)
      if (!res.ok) toast.error(res.error ?? '推送失败')
      else toast.info('推送完成')
      await get().refresh()
    } finally {
      set({ busy: false })
    }
  },

  pull: async () => {
    const root = cwd()
    if (!root) return
    set({ busy: true })
    try {
      const res = await window.lc.git.pull(root)
      if (!res.ok) toast.error(res.error ?? '拉取失败')
      else toast.info('拉取完成')
      await get().refresh()
    } finally {
      set({ busy: false })
    }
  },

  switchBranch: async () => {
    const root = cwd()
    if (!root) return
    const branches = await window.lc.git.listBranches(root)
    const hint =
      branches.length > 0
        ? `现有分支：${branches.map((b) => (b.current ? `${b.name}（当前）` : b.name)).join('、')}`
        : '当前没有其他分支'
    const picked = await useDialogStore.getState().prompt({
      title: '切换 / 新建分支',
      label: `${hint}\n输入要切换到的分支名（不存在则新建）：`,
      placeholder: '分支名',
      confirmText: '切换'
    })
    if (!picked || !picked.trim()) return
    const name = picked.trim()
    const exists = branches.some((b) => b.name === name)
    const res = await window.lc.git.checkoutBranch(root, name, !exists)
    if (!res.ok) {
      toast.error(res.error ?? '切换分支失败')
      return
    }
    toast.info(`已切换到分支 ${name}`)
    await get().refresh()
  }
}))

export function scheduleGitRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined
    void useGitStore.getState().refresh()
  }, 250)
}

export function statusLabel(s: GitFileStatus): string {
  switch (s) {
    case 'modified':
      return 'M'
    case 'added':
      return 'A'
    case 'deleted':
      return 'D'
    case 'renamed':
      return 'R'
    case 'copied':
      return 'C'
    case 'untracked':
      return 'U'
    case 'conflicted':
      return '!'
    default:
      return '?'
  }
}
