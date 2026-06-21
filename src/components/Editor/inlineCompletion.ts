import * as monaco from 'monaco-editor'
import type { FimResult } from '@shared/agentTypes'

const DEBOUNCE_MS = 250
const PREFIX_CHAR_BUDGET = 3000
const SUFFIX_CHAR_BUDGET = 1500
const MAX_TOKENS = 256

let enabled = false
let registration: monaco.IDisposable | null = null


export function setInlineCompletionEnabled(value: boolean): void {
  enabled = value
}


interface CacheEntry {
  key: string
  text: string
}

let cache: CacheEntry | null = null


function buildKey(prefix: string, suffix: string): string {
  
  return `${prefix.slice(-200)}\u0000${suffix.slice(0, 80)}`
}


function delay(ms: number, token: monaco.CancellationToken): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(true), ms)
    token.onCancellationRequested(() => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}


function extractContext(
  model: monaco.editor.ITextModel,
  position: monaco.Position
): { prefix: string; suffix: string } {
  const offset = model.getOffsetAt(position)
  const full = model.getValue()
  const prefix = full.slice(Math.max(0, offset - PREFIX_CHAR_BUDGET), offset)
  const suffix = full.slice(offset, offset + SUFFIX_CHAR_BUDGET)
  return { prefix, suffix }
}


const provider: monaco.languages.InlineCompletionsProvider = {
  async provideInlineCompletions(model, position, _context, token) {
    if (!enabled) return { items: [] }

    const { prefix, suffix } = extractContext(model, position)
    if (!prefix.trim() && !suffix.trim()) return { items: [] }

    const key = buildKey(prefix, suffix)
    if (cache && cache.key === key && cache.text) {
      return { items: [{ insertText: cache.text, range: rangeAt(position) }] }
    }

    
    const proceed = await delay(DEBOUNCE_MS, token)
    if (!proceed || token.isCancellationRequested) return { items: [] }

    let result: FimResult
    try {
      result = await window.lc.aiFimComplete({ prefix, suffix, maxTokens: MAX_TOKENS })
    } catch {
      return { items: [] }
    }
    if (token.isCancellationRequested) return { items: [] }
    if (!result.ok || !result.text) return { items: [] }

    cache = { key, text: result.text }
    return { items: [{ insertText: result.text, range: rangeAt(position) }] }
  },
  freeInlineCompletions() {
    
  }
}


function rangeAt(position: monaco.Position): monaco.IRange {
  return {
    startLineNumber: position.lineNumber,
    startColumn: position.column,
    endLineNumber: position.lineNumber,
    endColumn: position.column
  }
}


export function registerInlineCompletionProvider(): monaco.IDisposable {
  if (registration) return registration
  registration = monaco.languages.registerInlineCompletionsProvider({ pattern: '**' }, provider)
  return registration
}


export function disposeInlineCompletionProvider(): void {
  registration?.dispose()
  registration = null
  cache = null
}
