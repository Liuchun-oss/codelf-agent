import type { ChatMessageView } from '@/stores/agentStore'
import { detectLanguage } from '@/utils/language'
import { isRunnable, BROWSER_LANGUAGES } from '@/components/Editor/runners'

export type ArtifactKind = 'web' | 'runnable' | 'image' | 'pdf' | 'text' | 'other'

export interface Artifact {
  path: string
  name: string
  language: string
  kind: ArtifactKind
  // 该产物最后一次「应用写入」对应的消息 id，作为版本签名：
  // 用户关闭某标签后，若同路径再次被写入（签名变化），标签会自动恢复显示。
  sig: string
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
export function classifyArtifact(path: string, sig = ''): Artifact {
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

  return { path, name, language, kind, sig }
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
    // 用消息 id 作为版本签名：同路径再次写入时 id 变化，可触发已关闭标签恢复。
    byPath.set(path, classifyArtifact(path, m.id))
  }

  return order.map((p) => byPath.get(p)!).filter(Boolean)
}
