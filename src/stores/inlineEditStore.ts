import { create } from 'zustand'

export type InlineEditStatus = 'input' | 'loading' | 'diff' | 'error'

interface InlineEditState {
  
  active: boolean
  
  path: string | null
  
  status: InlineEditStatus
  
  instruction: string
  
  error: string | null
  
  top: number
  left: number
  width: number
  
  anchorLine: number

  open: (
    path: string,
    pos: { top: number; left: number; width: number; anchorLine: number }
  ) => void
  setInstruction: (v: string) => void
  setStatus: (s: InlineEditStatus) => void
  setError: (e: string | null) => void
  setPosition: (pos: { top: number; left: number; width: number }) => void
  close: () => void
}

export const useInlineEditStore = create<InlineEditState>((set) => ({
  active: false,
  path: null,
  status: 'input',
  instruction: '',
  error: null,
  top: 0,
  left: 0,
  width: 480,
  anchorLine: 1,

  open: (path, pos) =>
    set({
      active: true,
      path,
      status: 'input',
      instruction: '',
      error: null,
      top: pos.top,
      left: pos.left,
      width: pos.width,
      anchorLine: pos.anchorLine
    }),
  setInstruction: (v) => set({ instruction: v }),
  setStatus: (s) => set({ status: s }),
  setError: (e) => set({ error: e, status: e ? 'error' : 'input' }),
  setPosition: (pos) => set({ top: pos.top, left: pos.left, width: pos.width }),
  close: () => set({ active: false, path: null, status: 'input', instruction: '', error: null })
}))
