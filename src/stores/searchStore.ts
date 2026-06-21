import { create } from 'zustand'
import type { SearchFileResult, SearchOptions } from '@/types'
import { useWorkspaceStore } from '@/stores/workspaceStore'

interface SearchState {
  query: string
  replacement: string
  options: SearchOptions
  results: SearchFileResult[]
  loading: boolean
  truncated: boolean
  error: string | null
  
  collapsed: Set<string>

  setQuery: (q: string) => void
  setReplacement: (r: string) => void
  toggleOption: (key: keyof SearchOptions) => void
  toggleCollapsed: (path: string) => void
  run: () => Promise<void>
  replaceAll: () => Promise<number>
  clear: () => void
}

let runToken = 0

export const useSearchStore = create<SearchState>((set, get) => ({
  query: '',
  replacement: '',
  options: { caseSensitive: false, wholeWord: false, regex: false },
  results: [],
  loading: false,
  truncated: false,
  error: null,
  collapsed: new Set<string>(),

  setQuery: (q) => set({ query: q }),
  setReplacement: (r) => set({ replacement: r }),
  toggleOption: (key) =>
    set((s) => ({ options: { ...s.options, [key]: !s.options[key] } })),
  toggleCollapsed: (path) =>
    set((s) => {
      const next = new Set(s.collapsed)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return { collapsed: next }
    }),

  run: async () => {
    const { query, options } = get()
    const root = useWorkspaceStore.getState().workspace?.path
    if (!root || !query) {
      set({ results: [], truncated: false, error: null, loading: false })
      return
    }
    const token = ++runToken
    set({ loading: true, error: null })
    const res = await window.lc.searchInFiles(root, query, options)
    if (token !== runToken) return 
    if (!res.ok) {
      set({ loading: false, results: [], truncated: false, error: res.error ?? '搜索失败' })
      return
    }
    set({ loading: false, results: res.results, truncated: res.truncated, collapsed: new Set() })
  },

  replaceAll: async () => {
    const { query, replacement, options, results } = get()
    if (!query || results.length === 0) return 0
    const paths = results.map((r) => r.path)
    const res = await window.lc.searchReplace(paths, query, replacement, options)
    await get().run()
    return res.changed
  },

  clear: () => set({ results: [], truncated: false, error: null, query: '' })
}))
