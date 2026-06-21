import { create } from 'zustand'
import type { SemanticProgress } from '@/types'

interface SemanticIndexState {
  active: boolean
  phase: SemanticProgress['phase'] | null
  filesTotal: number
  filesProcessed: number
  chunksEmbedded: number
  // 大仓库超过自动阈值，等待用户手动触发构建。
  needsManual: boolean
  pendingFileCount: number
  setProgress: (p: SemanticProgress) => void
  setNeedsManual: (fileCount: number) => void
  clearNeedsManual: () => void
  reset: () => void
}

// 进度完成/出错后短暂保留再隐藏，避免进度条一闪而过。
let hideTimer: ReturnType<typeof setTimeout> | null = null

export const useSemanticIndexStore = create<SemanticIndexState>((set) => ({
  active: false,
  phase: null,
  filesTotal: 0,
  filesProcessed: 0,
  chunksEmbedded: 0,
  needsManual: false,
  pendingFileCount: 0,
  setProgress: (p) => {
    if (hideTimer) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
    // 一旦开始构建，清除“待手动”提示。
    const base = { needsManual: false }
    if (p.phase === 'done' || p.phase === 'error') {
      set({
        ...base,
        active: true,
        phase: p.phase,
        filesTotal: p.filesTotal,
        filesProcessed: p.filesProcessed,
        chunksEmbedded: p.chunksEmbedded
      })
      hideTimer = setTimeout(() => set({ active: false, phase: null }), 1200)
      return
    }
    set({
      ...base,
      active: true,
      phase: p.phase,
      filesTotal: p.filesTotal,
      filesProcessed: p.filesProcessed,
      chunksEmbedded: p.chunksEmbedded
    })
  },
  setNeedsManual: (fileCount) => {
    if (hideTimer) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
    set({ needsManual: true, pendingFileCount: fileCount, active: false, phase: null })
  },
  clearNeedsManual: () => set({ needsManual: false, pendingFileCount: 0 }),
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
      needsManual: false,
      pendingFileCount: 0
    })
  }
}))
