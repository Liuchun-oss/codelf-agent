import { create } from 'zustand'
import { useDialogStore } from '@/stores/dialogStore'

export interface HomeTerminalTab {
  id: string
  title: string
  cwd: string
  /** 归属的对话 session id，用于按对话过滤（与产物/视频队列口径一致） */
  sessionId: string | null
}

interface HomeTerminalState {
  sessions: HomeTerminalTab[]
  createSession: (sessionId: string | null, cwd?: string) => Promise<string | null>
  closeSession: (id: string) => Promise<void>
}

/**
 * 对话模式右侧产物面板内的终端会话。与 IDE 底部 TerminalDock 使用的
 * terminalStore 完全独立，避免在对话里开终端时误触发/切换 IDE 的终端面板。
 * 复用同一套 terminal:* IPC（主进程按 id 管理 pty），因此渲染层可直接用 XtermView。
 */
export const useHomeTerminalStore = create<HomeTerminalState>((set) => ({
  sessions: [],

  createSession: async (sessionId, cwd) => {
    const res = await window.lc.terminalCreate(cwd ?? '')
    if (!res.ok || !res.id) {
      void useDialogStore.getState().confirm({
        title: '终端启动失败',
        message: res.error ?? '无法创建终端会话',
        confirmText: '知道了',
        cancelText: '关闭'
      })
      return null
    }
    const tab: HomeTerminalTab = {
      id: res.id,
      title: res.title ?? '终端',
      cwd: res.cwd ?? cwd ?? '',
      sessionId
    }
    set((s) => ({ sessions: [...s.sessions, tab] }))
    return res.id
  },

  closeSession: async (id) => {
    await window.lc.terminalKill(id)
    set((s) => ({ sessions: s.sessions.filter((t) => t.id !== id) }))
  }
}))
