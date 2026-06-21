import { create } from 'zustand'
import type { PythonEnv } from '@shared/pythonTypes'
import { useWorkspaceStore } from '@/stores/workspaceStore'

interface PythonState {
  
  envs: PythonEnv[]
  
  selected: PythonEnv | null
  
  loading: boolean
  
  loaded: boolean
  
  discovered: boolean

  
  init: () => Promise<void>
  
  discover: (force?: boolean) => Promise<void>
  
  select: (env: PythonEnv) => Promise<void>
  
  browse: () => Promise<void>
}

function workspaceRoot(): string | undefined {
  return useWorkspaceStore.getState().workspace?.path
}

export const usePythonStore = create<PythonState>((set, get) => ({
  envs: [],
  selected: null,
  loading: false,
  loaded: false,
  discovered: false,

  init: async () => {
    if (get().loaded || get().loading) return
    const res = await window.lc.python.getSelected(workspaceRoot())
    if (res.ok && res.env) set({ selected: res.env })
    set({ loaded: true })
  },

  discover: async (force = false) => {
    
    if (get().loading) return
    if (get().discovered && !force) return
    set({ loading: true })
    try {
      const res = await window.lc.python.discover(workspaceRoot())
      if (res.ok) {
        set({ envs: res.envs, discovered: true })
        
        if (!get().selected && res.envs.length > 0) {
          const rec = res.envs.find((e) => e.recommended) ?? res.envs[0]
          set({ selected: rec })
        }
      }
    } finally {
      set({ loading: false })
    }
  },

  select: async (env) => {
    const res = await window.lc.python.setSelected(workspaceRoot(), env.executable)
    
    set({ selected: res.ok && res.env ? { ...env, ...res.env, label: env.label, kind: env.kind } : env })
    const { restartPythonLsp } = await import('@/lsp/registry')
    restartPythonLsp()
  },

  browse: async () => {
    const res = await window.lc.python.browse()
    if (!res.ok || !res.env) return
    const env = res.env
    
    await window.lc.python.setSelected(workspaceRoot(), env.executable)
    set((s) => {
      const exists = s.envs.some((e) => e.id === env.id)
      return {
        selected: env,
        envs: exists ? s.envs : [env, ...s.envs]
      }
    })
    const { restartPythonLsp } = await import('@/lsp/registry')
    restartPythonLsp()
  }
}))
