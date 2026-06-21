import { create } from 'zustand'
import { appStorageKey } from '@shared/appConfig'
import type { Workspace } from '@/types'

const SIZE_KEY = appStorageKey('layout')

interface LayoutSizes {
  sidebarWidth: number
  agentWidth: number
  terminalHeight: number
}

const DEFAULTS: LayoutSizes = { sidebarWidth: 240, agentWidth: 340, terminalHeight: 240 }


const LIMITS = {
  sidebar: { min: 160, max: 600 },
  agent: { min: 240, max: 720 },
  terminal: { min: 80, max: 1200 }
}

const clamp = (v: number, min: number, max: number): number => Math.min(Math.max(v, min), max)

function terminalMax(): number {
  const win =
    typeof window !== 'undefined' && window.innerHeight > 0
      ? Math.round(window.innerHeight * 0.8)
      : LIMITS.terminal.max
  return Math.max(LIMITS.terminal.min, Math.min(LIMITS.terminal.max, win))
}

function loadSizes(): LayoutSizes {
  try {
    const raw = localStorage.getItem(SIZE_KEY)
    if (!raw) return { ...DEFAULTS }
    const p = JSON.parse(raw) as Partial<LayoutSizes>
    return {
      sidebarWidth: clamp(
        typeof p.sidebarWidth === 'number' ? p.sidebarWidth : DEFAULTS.sidebarWidth,
        LIMITS.sidebar.min,
        LIMITS.sidebar.max
      ),
      agentWidth: clamp(
        typeof p.agentWidth === 'number' ? p.agentWidth : DEFAULTS.agentWidth,
        LIMITS.agent.min,
        LIMITS.agent.max
      ),
      terminalHeight: clamp(
        typeof p.terminalHeight === 'number' ? p.terminalHeight : DEFAULTS.terminalHeight,
        LIMITS.terminal.min,
        terminalMax()
      )
    }
  } catch {
    return { ...DEFAULTS }
  }
}

function saveSizes(s: LayoutSizes): void {
  try {
    localStorage.setItem(SIZE_KEY, JSON.stringify(s))
  } catch {
    
  }
}

export type SidebarView = 'explorer' | 'search' | 'scm' | 'knowledge'

export type AppView = 'home' | 'workspace'

const PREFS_KEY = appStorageKey('ui-prefs')

function loadShowIgnored(): boolean {
  try {
    return localStorage.getItem(PREFS_KEY) === '1'
  } catch {
    return false
  }
}

function saveShowIgnored(v: boolean): void {
  try {
    localStorage.setItem(PREFS_KEY, v ? '1' : '0')
  } catch {
    
  }
}

interface UiState {

  appView: AppView
  setAppView: (view: AppView) => void
  /** 首页是否处于全宽聊天视图（提升到 store：去 IDE 再回首页不丢聊天现场） */
  homeChatOpen: boolean
  setHomeChatOpen: (v: boolean) => void
  /** 首页左侧会话侧栏是否展开（同样提升：视图切换不丢收起状态） */
  homeSidebarOpen: boolean
  setHomeSidebarOpen: (v: boolean) => void
  /** 对话模式下右侧「产物预览」栏是否展开（仅当存在可预览产物时生效） */
  homeArtifactOpen: boolean
  setHomeArtifactOpen: (v: boolean) => void
  /** 产物预览栏宽度（px），可拖拽分隔条调整 */
  homeArtifactWidth: number
  setHomeArtifactWidth: (w: number) => void
  /** 对话模式下用户选择的工作区（供切换到 IDE 时使用） */
  homePickedWorkspace: Workspace | null
  setHomePickedWorkspace: (ws: Workspace | null) => void
  showFileTree: boolean
  showAgentPanel: boolean
  showTerminal: boolean
  showSettings: boolean
  sidebarView: SidebarView
  sidebarWidth: number
  agentWidth: number
  terminalHeight: number
  
  showIgnoredFiles: boolean
  setSidebarView: (view: SidebarView) => void
  
  openSidebarView: (view: SidebarView) => void
  showSidebarView: (view: SidebarView) => void
  setShowSettings: (v: boolean) => void
  toggleFileTree: () => void
  toggleAgentPanel: () => void
  toggleTerminal: () => void
  setTerminalVisible: (v: boolean) => void
  setSidebarWidth: (w: number) => void
  setAgentWidth: (w: number) => void
  setTerminalHeight: (h: number) => void
  
  toggleShowIgnoredFiles: () => void
}

export const useUiStore = create<UiState>((set, get) => {
  const initial = loadSizes()
  const persist = (): void => {
    const s = get()
    saveSizes({
      sidebarWidth: s.sidebarWidth,
      agentWidth: s.agentWidth,
      terminalHeight: s.terminalHeight
    })
  }

  return {
    appView: 'home',
    setAppView: (view) => set({ appView: view }),
    homeChatOpen: false,
    setHomeChatOpen: (v) => set({ homeChatOpen: v }),
    homeSidebarOpen: true,
    setHomeSidebarOpen: (v) => set({ homeSidebarOpen: v }),
    homeArtifactOpen: true,
    setHomeArtifactOpen: (v) => set({ homeArtifactOpen: v }),
    homeArtifactWidth: 520,
    setHomeArtifactWidth: (w) => set({ homeArtifactWidth: Math.max(320, Math.min(w, 1100)) }),
    homePickedWorkspace: null,
    setHomePickedWorkspace: (ws) => set({ homePickedWorkspace: ws }),
    showFileTree: true,
    showAgentPanel: true,
    showTerminal: false,
    showSettings: false,
    sidebarView: 'explorer',
    sidebarWidth: initial.sidebarWidth,
    agentWidth: initial.agentWidth,
    terminalHeight: initial.terminalHeight,
    showIgnoredFiles: loadShowIgnored(),

    setSidebarView: (view) => set({ sidebarView: view }),
    openSidebarView: (view) => set({ showFileTree: true, sidebarView: view }),
    setShowSettings: (v) => set({ showSettings: v }),
    
    showSidebarView: (view) =>
      set((s) =>
        s.showFileTree && s.sidebarView === view
          ? { showFileTree: false }
          : { showFileTree: true, sidebarView: view }
      ),

    toggleFileTree: () => set((s) => ({ showFileTree: !s.showFileTree })),
    toggleAgentPanel: () => set((s) => ({ showAgentPanel: !s.showAgentPanel })),
    toggleTerminal: () => set((s) => ({ showTerminal: !s.showTerminal })),
    setTerminalVisible: (v) => set({ showTerminal: v }),

    setSidebarWidth: (w) => {
      set({ sidebarWidth: clamp(Math.round(w), LIMITS.sidebar.min, LIMITS.sidebar.max) })
      persist()
    },
    setAgentWidth: (w) => {
      set({ agentWidth: clamp(Math.round(w), LIMITS.agent.min, LIMITS.agent.max) })
      persist()
    },
    setTerminalHeight: (h) => {
      
      set({ terminalHeight: clamp(Math.round(h), LIMITS.terminal.min, terminalMax()) })
      persist()
    },

    toggleShowIgnoredFiles: () => {
      const next = !get().showIgnoredFiles
      set({ showIgnoredFiles: next })
      saveShowIgnored(next)
    }
  }
})
