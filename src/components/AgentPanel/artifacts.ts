import type { ChatMessageView } from '@/stores/agentStore'
import { detectLanguage } from '@/utils/language'
import { isRunnable, BROWSER_LANGUAGES } from '@/components/Editor/runners'

export type ArtifactKind = 'web' | 'runnable' | 'image' | 'pdf' | 'text' | 'other'

export interface Artifact {
  path: string
  name: string
  language: string
  kind: ArtifactKind
}

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg'])
const TEXT_LANGS = new Set([
  'markdown',
  'json',
  'yaml',
  'toml',
  'ini',
  'xml',
  'csv',
  'sql',
  'plaintext',
  'diff'
])

function basename(p: string): string {
  return p.split(/[\\/]/).pop() || p
}

function extOf(p: string): string {
  const name = basename(p).toLowerCase()
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1) : ''
}

/** Classify a file into an artifact kind for the preview panel. */
export function classifyArtifact(path: string): Artifact {
  const language = detectLanguage(path)
  const ext = extOf(path)
  const name = basename(path)

  let kind: ArtifactKind
  if (BROWSER_LANGUAGES.has(language)) {
    kind = 'web'
  } else if (IMAGE_EXT.has(ext)) {
    kind = 'image'
  } else if (ext === 'pdf') {
    kind = 'pdf'
  } else if (isRunnable(language, path)) {
    kind = 'runnable'
  } else if (ext === 'csv' || TEXT_LANGS.has(language)) {
    kind = 'text'
  } else {
    kind = 'other'
  }

  return { path, name, language, kind }
}

/**
 * Derive the set of previewable artifacts from a conversation's messages.
 * Only files that were actually written (applied) are surfaced, deduped by
 * path with the latest occurrence winning, preserving first-seen order.
 */
export function deriveArtifacts(messages: ChatMessageView[]): Artifact[] {
  const order: string[] = []
  const byPath = new Map<string, Artifact>()

  for (const m of messages) {
    if (m.role !== 'filechange') continue
    if (m.fileStatus !== 'applied') continue
    const path = m.filePath
    if (!path) continue
    if (!byPath.has(path)) order.push(path)
    byPath.set(path, classifyArtifact(path))
  }

  return order.map((p) => byPath.get(p)!).filter(Boolean)
}
