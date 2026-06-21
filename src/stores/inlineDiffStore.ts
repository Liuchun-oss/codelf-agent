import { create } from 'zustand'
import { parseDiff, reconstructOldContent, reconstructNewContent, type ParsedDiff } from '@/utils/parseDiff'

export interface InlineDiffEntry {
  
  path: string
  
  rawDiff: string
  
  parsed: ParsedDiff
  
  oldContent: string
  
  newContent: string
}

interface InlineDiffState {
  
  diffs: Map<string, InlineDiffEntry>

  
  acceptedPaths: Set<string>

  
  proposeDiff: (path: string, rawDiff: string, oldContent: string, newContent: string) => void
  
  proposeDiffFromRaw: (path: string, rawDiff: string) => void
  
  clearDiff: (path: string) => void
  
  acceptDiff: (path: string) => InlineDiffEntry | undefined
  
  consumeAccepted: (path: string) => boolean
  
  clearAll: () => void
  
  getEntry: (path: string) => InlineDiffEntry | undefined
}

export const useInlineDiffStore = create<InlineDiffState>((set, get) => ({
  diffs: new Map(),
  acceptedPaths: new Set(),

  proposeDiff: (path, rawDiff, oldContent, newContent) => {
    const parsed = parseDiff(rawDiff)
    const entry: InlineDiffEntry = { path, rawDiff, parsed, oldContent, newContent }
    set((s) => {
      const next = new Map(s.diffs)
      next.set(path, entry)
      return { diffs: next }
    })
  },

  proposeDiffFromRaw: (path, rawDiff) => {
    const parsed = parseDiff(rawDiff)
    const oldContent = reconstructOldContent(rawDiff)
    const newContent = reconstructNewContent(rawDiff)
    const entry: InlineDiffEntry = { path, rawDiff, parsed, oldContent, newContent }
    set((s) => {
      const next = new Map(s.diffs)
      next.set(path, entry)
      return { diffs: next }
    })
  },

  clearDiff: (path) => {
    set((s) => {
      if (!s.diffs.has(path)) return s
      const next = new Map(s.diffs)
      next.delete(path)
      return { diffs: next }
    })
  },

  
  acceptDiff: (path) => {
    const entry = get().diffs.get(path)
    if (!entry) return undefined
    set((s) => {
      const next = new Map(s.diffs)
      next.delete(path)
      const accepted = new Set(s.acceptedPaths)
      accepted.add(path)
      return { diffs: next, acceptedPaths: accepted }
    })
    return entry
  },

  
  consumeAccepted: (path) => {
    const has = get().acceptedPaths.has(path)
    if (!has) return false
    set((s) => {
      const accepted = new Set(s.acceptedPaths)
      accepted.delete(path)
      return { acceptedPaths: accepted }
    })
    return true
  },

  clearAll: () => {
    set({ diffs: new Map(), acceptedPaths: new Set() })
  },

  getEntry: (path) => get().diffs.get(path)
}))
