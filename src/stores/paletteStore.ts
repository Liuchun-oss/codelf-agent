import { create } from 'zustand'

export type PaletteMode = 'commands' | 'files'

interface PaletteState {
  mode: PaletteMode | null
  open: (mode: PaletteMode) => void
  close: () => void
  toggle: (mode: PaletteMode) => void
}

export const usePaletteStore = create<PaletteState>((set, get) => ({
  mode: null,
  open: (mode) => set({ mode }),
  close: () => set({ mode: null }),
  toggle: (mode) => set({ mode: get().mode === mode ? null : mode })
}))
