import { create } from 'zustand'
import type { KnowledgeProgress } from '@/types'

interface KnowledgeIndexState {
  active: boolean
  phase: KnowledgeProgress['phase'] | null
  filesTotal: number
  filesProcessed: number
  chunksEmbedded: number
  currentFile?: string
  setProgress: (p: KnowledgeProgress) => void
  reset: () => void
}

let hideTimer: ReturnType<typeof setTimeout> | null = null

export const useKnowledgeStore = create<KnowledgeIndexState>((set) => ({
  active: false,
  phase: null,
  filesTotal: 0,
  filesProcessed: 0,
  chunksEmbedded: 0,
  currentFile: undefined,
  setProgress: (p) => {
    if (hideTimer) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
    if (p.phase === 'done' || p.phase === 'error') {
      set({
        active: true,
        phase: p.phase,
        filesTotal: p.filesTotal,
        filesProcessed: p.filesProcessed,
        chunksEmbedded: p.chunksEmbedded,
        currentFile: p.currentFile
      })
      hideTimer = setTimeout(() => set({ active: false, phase: null }), 2000)
      return
    }
    set({
      active: true,
      phase: p.phase,
      filesTotal: p.filesTotal,
      filesProcessed: p.filesProcessed,
      chunksEmbedded: p.chunksEmbedded,
      currentFile: p.currentFile
    })
  },
  reset: () => {
    if (hideTimer) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
    set({
      active: false,
      phase: null,
      filesTotal: 0,
      filesProcessed: 0,
      chunksEmbedded: 0,
      currentFile: undefined
    })
  }
}))
