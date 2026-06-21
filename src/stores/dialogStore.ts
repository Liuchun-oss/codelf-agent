import { create } from 'zustand'

interface PromptOptions {
  title: string
  label: string
  defaultValue?: string
  placeholder?: string
  confirmText?: string
  
  selectionEnd?: number
  
  validate?: (value: string) => string | null
}

interface ConfirmOptions {
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
}

export interface ChooseButton {
  key: string
  label: string
  danger?: boolean
  primary?: boolean
}

interface ChooseOptions {
  title: string
  message: string
  buttons: ChooseButton[]
}

export interface PickItem {
  key: string
  label: string
  detail?: string
}

interface PickOptions {
  title: string
  message?: string
  items: PickItem[]
}

type ActiveDialog =
  | { kind: 'prompt'; options: PromptOptions; resolve: (v: string | null) => void }
  | { kind: 'confirm'; options: ConfirmOptions; resolve: (v: boolean) => void }
  | { kind: 'choose'; options: ChooseOptions; resolve: (v: string | null) => void }
  | { kind: 'pick'; options: PickOptions; resolve: (v: string | null) => void }
  | null


function cancelDialog(d: NonNullable<ActiveDialog>): void {
  if (d.kind === 'confirm') d.resolve(false)
  else d.resolve(null)
}

interface DialogState {
  active: ActiveDialog
  prompt: (options: PromptOptions) => Promise<string | null>
  confirm: (options: ConfirmOptions) => Promise<boolean>
  choose: (options: ChooseOptions) => Promise<string | null>
  pick: (options: PickOptions) => Promise<string | null>
  _close: () => void
}

export const useDialogStore = create<DialogState>((set, get) => ({
  active: null,

  prompt: (options) =>
    new Promise<string | null>((resolve) => {
      const prev = get().active
      if (prev) cancelDialog(prev)
      set({ active: { kind: 'prompt', options, resolve } })
    }),

  confirm: (options) =>
    new Promise<boolean>((resolve) => {
      const prev = get().active
      if (prev) cancelDialog(prev)
      set({ active: { kind: 'confirm', options, resolve } })
    }),

  choose: (options) =>
    new Promise<string | null>((resolve) => {
      const prev = get().active
      if (prev) cancelDialog(prev)
      set({ active: { kind: 'choose', options, resolve } })
    }),

  pick: (options) =>
    new Promise<string | null>((resolve) => {
      const prev = get().active
      if (prev) cancelDialog(prev)
      set({ active: { kind: 'pick', options, resolve } })
    }),

  _close: () => set({ active: null })
}))
