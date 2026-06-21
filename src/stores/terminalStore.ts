import { create } from 'zustand'
import { useUiStore } from '@/stores/uiStore'
import { useDialogStore } from '@/stores/dialogStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'

export interface TerminalTab {
  id: string
  title: string
  cwd: string
}

interface TerminalState {
  sessions: TerminalTab[]
  activeId: string | null

  createSession: (cwd?: string) => Promise<void>
  closeSession: (id: string) => Promise<void>
  
  removeSession: (id: string) => void
  setActive: (id: string) => void
  
  toggle: () => Promise<void>
  
  runCommand: (command: string) => Promise<void>
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  sessions: [],
  activeId: null,

  createSession: async (cwd) => {
    const res = await window.lc.terminalCreate(cwd ?? '')
    if (!res.ok || !res.id) {
      void useDialogStore.getState().confirm({
        title: '终端启动失败',
        message: res.error ?? '无法创建终端会话',
        confirmText: '知道了',
        cancelText: '关闭'
      })
      return
    }
    const tab: TerminalTab = {
      id: res.id,
      title: res.title ?? '终端',
      cwd: res.cwd ?? cwd ?? ''
    }
    
    
    set((s) => ({ sessions: [...s.sessions, tab], activeId: res.id! }))
    useUiStore.getState().setTerminalVisible(true)
  },

  closeSession: async (id) => {
    await window.lc.terminalKill(id)
    get().removeSession(id)
  },

  removeSession: (id) => {
    set((s) => {
      const idx = s.sessions.findIndex((t) => t.id === id)
      if (idx === -1) return s
      const sessions = s.sessions.filter((t) => t.id !== id)
      let activeId = s.activeId
      if (activeId === id) {
        const next = sessions[idx] ?? sessions[idx - 1] ?? null
        activeId = next ? next.id : null
      }
      return { sessions, activeId }
    })
    if (get().sessions.length === 0) useUiStore.getState().setTerminalVisible(false)
  },

  setActive: (id) => set({ activeId: id }),

  toggle: async () => {
    const ui = useUiStore.getState()
    if (ui.showTerminal) {
      ui.setTerminalVisible(false)
      return
    }
    ui.setTerminalVisible(true)
    if (get().sessions.length === 0) {
      const cwd = useWorkspaceStore.getState().workspace?.path
      await get().createSession(cwd)
    }
  },

  runCommand: async (command) => {
    const ui = useUiStore.getState()
    ui.setTerminalVisible(true)

    const workspaceRoot = useWorkspaceStore.getState().workspace?.path
    const active = get().sessions.find((t) => t.id === get().activeId) ?? null

    
    
    const needNewSession =
      !active || (!!workspaceRoot && normalizeCwd(active.cwd) !== normalizeCwd(workspaceRoot))

    if (needNewSession) {
      await get().createSession(workspaceRoot)
    }

    const id = get().activeId
    if (!id) return
    
    await new Promise((r) => setTimeout(r, 60))
    await window.lc.terminalWrite(id, command + '\r')
  }
}))

function normalizeCwd(p: string | undefined): string {
  if (!p) return ''
  return p.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()
}
