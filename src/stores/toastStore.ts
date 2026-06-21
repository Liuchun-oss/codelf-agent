import { create } from 'zustand'

export type ToastKind = 'info' | 'warn' | 'error'

export interface Toast {
  id: number
  text: string
  kind: ToastKind
}

interface ToastState {
  toasts: Toast[]
  push: (text: string, kind?: ToastKind, timeoutMs?: number) => void
  dismiss: (id: number) => void
}

let seq = 1

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (text, kind = 'info', timeoutMs = 5000) => {
    if (get().toasts.some((t) => t.text === text && t.kind === kind)) return
    const id = seq++
    set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }))
    if (timeoutMs > 0) setTimeout(() => get().dismiss(id), timeoutMs)
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}))


export const toast = {
  info: (t: string) => useToastStore.getState().push(t, 'info'),
  warn: (t: string) => useToastStore.getState().push(t, 'warn'),
  error: (t: string) => useToastStore.getState().push(t, 'error')
}
