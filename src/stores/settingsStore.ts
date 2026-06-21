import { create } from 'zustand'
import { appStorageKey } from '@shared/appConfig'



export type WordWrap = 'on' | 'off'

export interface Settings {
  fontSize: number
  tabSize: number
  wordWrap: WordWrap
  minimap: boolean
  formatOnSave: boolean
}

const STORAGE_KEY = appStorageKey('settings')

const DEFAULTS: Settings = {
  fontSize: 14,
  tabSize: 2,
  wordWrap: 'on',
  minimap: true,
  formatOnSave: false
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    const p = JSON.parse(raw) as Partial<Settings>
    return { ...DEFAULTS, ...p }
  } catch {
    return { ...DEFAULTS }
  }
}

interface SettingsState extends Settings {
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void
  reset: () => void
}

function persist(s: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch {
    
  }
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...load(),
  set: (key, value) => {
    set({ [key]: value } as Partial<SettingsState>)
    const { set: _s, reset: _r, ...rest } = get()
    persist(rest as Settings)
  },
  reset: () => {
    set({ ...DEFAULTS })
    persist({ ...DEFAULTS })
  }
}))
