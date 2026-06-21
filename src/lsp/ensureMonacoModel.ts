import * as monaco from 'monaco-editor'
import { detectLanguage } from '@/utils/language'
import { findModelByUri } from './uri'


export async function ensureMonacoModelForUri(
  uri: monaco.Uri
): Promise<monaco.editor.ITextModel | null> {
  const existing = findModelByUri(uri.toString())
  if (existing) return existing

  const fsPath = uri.fsPath
  if (!fsPath) return null

  const res = await window.lc.readFileSafe(fsPath)
  if (!res.ok || res.kind !== 'text' || res.content === undefined) return null

  const again = findModelByUri(uri.toString())
  if (again) return again

  return monaco.editor.createModel(res.content, detectLanguage(fsPath), uri)
}

export async function ensureModelsForLocations(
  def: monaco.languages.Location | monaco.languages.Location[] | null
): Promise<void> {
  if (!def) return
  const locs = Array.isArray(def) ? def : [def]
  await Promise.all(locs.map((loc) => ensureMonacoModelForUri(loc.uri)))
}
