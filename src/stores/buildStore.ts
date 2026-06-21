import { create } from 'zustand'
import type { BuildPlan } from '@/components/Editor/buildSystem'
import { detectBuildPlans } from '@/components/Editor/buildSystem'

interface BuildState {
  
  plans: BuildPlan[]
  
  loading: boolean
  
  refresh: (root: string | null) => Promise<void>
}

let refreshToken = 0

export const useBuildStore = create<BuildState>((set) => ({
  plans: [],
  loading: false,

  refresh: async (root) => {
    const token = ++refreshToken
    if (!root) {
      set({ plans: [], loading: false })
      return
    }
    set({ loading: true })
    try {
      const plans = await detectBuildPlans(root)
      
      if (token !== refreshToken) return
      set({ plans, loading: false })
    } catch {
      if (token !== refreshToken) return
      set({ plans: [], loading: false })
    }
  }
}))
