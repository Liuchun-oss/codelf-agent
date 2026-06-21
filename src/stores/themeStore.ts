import { create } from 'zustand'
import { appStorageKey } from '@shared/appConfig'

export interface ThemePreset {
  id: string
  label: string
  /** True for light-background presets; drives editor/highlight theme choice. */
  light?: boolean
  vars: Record<string, string>
}

/**
 * Vars that live in :root but aren't part of every preset. We apply these as a
 * base so a preset can override them (e.g. light theme needs softer shadows and
 * lighter active states) without leaking values when switching between presets.
 */
export const BASE_THEME_VARS: Record<string, string> = {
  // active/选中态从强调色派生（而非写死的青绿色调），
  // 这样对话列表、视图切换等所有选中态与用户强调色自动保持一致
  '--bg-active': 'rgba(var(--accent-rgb), 0.16)',
  '--bg-active-strong': 'rgba(var(--accent-rgb), 0.30)',
  '--shadow-sm': '0 2px 8px rgba(0, 0, 0, 0.3)',
  '--shadow-md': '0 8px 28px rgba(0, 0, 0, 0.45)',
  '--shadow-lg': '0 16px 48px rgba(0, 0, 0, 0.55)'
}

/** Background/surface presets. Accent vars are applied separately. */
export const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'warm',
    label: '暖棕（默认）',
    vars: {
      '--bg': '#232020',
      '--bg-elevated': '#1b1918',
      '--bg-inset': '#141210',
      '--bg-panel': '#1b1918',
      '--bg-overlay': '#2a2624',
      '--bg-hover': '#332e2b',
      '--border': '#322d29',
      '--border-soft': '#272320',
      '--text': '#d8d2c8',
      '--text-dim': '#908a7e',
      '--text-bright': '#f0f0f0',
      '--statusbar-bg': '#1b1918',
      '--statusbar-fg': '#d8d2c8'
    }
  },
  {
    id: 'graphite',
    label: '石墨灰',
    vars: {
      '--bg': '#1f1f22',
      '--bg-elevated': '#191919',
      '--bg-inset': '#111113',
      '--bg-panel': '#191919',
      '--bg-overlay': '#26262a',
      '--bg-hover': '#2e2e34',
      '--border': '#33333a',
      '--border-soft': '#262629',
      '--text': '#d4d4d8',
      '--text-dim': '#8a8a92',
      '--text-bright': '#f4f4f5',
      '--statusbar-bg': '#191919',
      '--statusbar-fg': '#d4d4d8'
    }
  },
  {
    id: 'midnight',
    label: '午夜蓝',
    vars: {
      '--bg': '#1a1d29',
      '--bg-elevated': '#141722',
      '--bg-inset': '#0e1019',
      '--bg-panel': '#141722',
      '--bg-overlay': '#212536',
      '--bg-hover': '#2a2f44',
      '--border': '#2c3247',
      '--border-soft': '#21263a',
      '--text': '#cdd3e3',
      '--text-dim': '#828aa3',
      '--text-bright': '#f0f3fa',
      '--statusbar-bg': '#141722',
      '--statusbar-fg': '#cdd3e3'
    }
  },
  {
    id: 'black',
    label: '纯黑',
    vars: {
      '--bg': '#161616',
      '--bg-elevated': '#0e0e0e',
      '--bg-inset': '#080808',
      '--bg-panel': '#0e0e0e',
      '--bg-overlay': '#1d1d1d',
      '--bg-hover': '#262626',
      '--border': '#2a2a2a',
      '--border-soft': '#1d1d1d',
      '--text': '#d6d6d6',
      '--text-dim': '#8a8a8a',
      '--text-bright': '#f5f5f5',
      '--statusbar-bg': '#0e0e0e',
      '--statusbar-fg': '#d6d6d6'
    }
  },
  {
    id: 'daylight',
    label: '云白（亮色）',
    light: true,
    vars: {
      '--bg': '#ffffff',
      '--bg-elevated': '#f6f5f3',
      '--bg-inset': '#efedea',
      '--bg-panel': '#f6f5f3',
      '--bg-overlay': '#ffffff',
      '--bg-hover': '#eceae5',
      '--border': '#e2dfd9',
      '--border-soft': '#eeece7',
      '--text': '#000000',
      '--text-dim': '#8b857b',
      '--text-bright': '#000000',
      '--statusbar-bg': '#f6f5f3',
      '--statusbar-fg': '#000000',
      '--shadow-sm': '0 1px 3px rgba(40, 35, 28, 0.08)',
      '--shadow-md': '0 6px 20px rgba(40, 35, 28, 0.12)',
      '--shadow-lg': '0 14px 40px rgba(40, 35, 28, 0.16)'
    }
  }
]

export const ACCENT_PRESETS: { id: string; label: string; hex: string }[] = [
  { id: 'teal', label: '青绿', hex: '#5fa394' },
  { id: 'blue', label: '蓝', hex: '#5b9bd5' },
  { id: 'violet', label: '紫', hex: '#8b7ff0' },
  { id: 'pink', label: '粉', hex: '#e07a9b' },
  { id: 'amber', label: '琥珀', hex: '#d6a35a' },
  { id: 'green', label: '草绿', hex: '#6cc7a4' }
]

export const DEFAULT_PRESET_ID = 'warm'
export const DEFAULT_ACCENT = '#5fa394'

function clamp(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)))
}

function parseHex(hex: string): [number, number, number] {
  const m = hex.trim().replace('#', '')
  const v = m.length === 3 ? m.split('').map((c) => c + c).join('') : m
  const int = parseInt(v, 16)
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255]
}

function toHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((n) => clamp(n).toString(16).padStart(2, '0')).join('')
}

function lighten([r, g, b]: [number, number, number], amount: number): string {
  return toHex(r + (255 - r) * amount, g + (255 - g) * amount, b + (255 - b) * amount)
}

function darken([r, g, b]: [number, number, number], amount: number): string {
  return toHex(r * (1 - amount), g * (1 - amount), b * (1 - amount))
}

/**
 * Derives the full set of accent CSS vars from a single base hex color.
 * On light themes `--accent-bright` is darkened (not lightened) so accent-
 * colored text stays legible against a light background.
 */
export function accentVars(hex: string, light = false): Record<string, string> {
  const rgb = parseHex(hex)
  return {
    '--accent': hex,
    '--accent-hover': light ? darken(rgb, 0.1) : lighten(rgb, 0.12),
    '--accent-bright': light ? darken(rgb, 0.3) : lighten(rgb, 0.32),
    '--accent-rgb': `${rgb[0]}, ${rgb[1]}, ${rgb[2]}`
  }
}

export interface ThemeState {
  presetId: string
  accent: string
  setPreset: (id: string) => void
  setAccent: (hex: string) => void
  reset: () => void
}

const STORAGE_KEY = appStorageKey('theme')

interface PersistedTheme {
  presetId: string
  accent: string
}

function load(): PersistedTheme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { presetId: DEFAULT_PRESET_ID, accent: DEFAULT_ACCENT }
    const p = JSON.parse(raw) as Partial<PersistedTheme>
    // 持久化的预设可能已被移除（如下线的亮色主题），回退到默认值
    const validPreset =
      typeof p.presetId === 'string' && THEME_PRESETS.some((t) => t.id === p.presetId)
    return {
      presetId: validPreset ? (p.presetId as string) : DEFAULT_PRESET_ID,
      accent: typeof p.accent === 'string' ? p.accent : DEFAULT_ACCENT
    }
  } catch {
    return { presetId: DEFAULT_PRESET_ID, accent: DEFAULT_ACCENT }
  }
}

function persist(t: PersistedTheme): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(t))
  } catch {
    /* ignore quota errors */
  }
}

/** Whether the given (or currently active) preset uses a light background. */
export function isLightPreset(presetId?: string): boolean {
  const id = presetId ?? useThemeStore.getState().presetId
  return THEME_PRESETS.find((p) => p.id === id)?.light === true
}

/** Writes the active theme's CSS variables onto the document root. */
export function applyTheme(presetId: string, accent: string): void {
  const root = document.documentElement
  const preset = THEME_PRESETS.find((p) => p.id === presetId) ?? THEME_PRESETS[0]
  const vars = { ...BASE_THEME_VARS, ...preset.vars, ...accentVars(accent, preset.light === true) }
  for (const [key, value] of Object.entries(vars)) {
    root.style.setProperty(key, value)
  }
  root.dataset.themeMode = preset.light === true ? 'light' : 'dark'
  notifyThemeChange()
}

type ThemeListener = () => void
const themeListeners = new Set<ThemeListener>()

/** Subscribe to theme changes; returns an unsubscribe fn. Used by non-CSS surfaces (xterm, Monaco). */
export function onThemeChange(listener: ThemeListener): () => void {
  themeListeners.add(listener)
  return () => themeListeners.delete(listener)
}

function notifyThemeChange(): void {
  for (const listener of themeListeners) {
    try {
      listener()
    } catch {
      /* ignore listener errors */
    }
  }
}

/** Reads a resolved CSS custom property from :root, with a fallback. */
export function cssVar(name: string, fallback = ''): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  ...load(),
  setPreset: (id) => {
    set({ presetId: id })
    const { presetId, accent } = get()
    applyTheme(presetId, accent)
    persist({ presetId, accent })
  },
  setAccent: (hex) => {
    set({ accent: hex })
    const { presetId, accent } = get()
    applyTheme(presetId, accent)
    persist({ presetId, accent })
  },
  reset: () => {
    set({ presetId: DEFAULT_PRESET_ID, accent: DEFAULT_ACCENT })
    applyTheme(DEFAULT_PRESET_ID, DEFAULT_ACCENT)
    persist({ presetId: DEFAULT_PRESET_ID, accent: DEFAULT_ACCENT })
  }
}))
