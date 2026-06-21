import * as monaco from 'monaco-editor'






export function pathToUri(osPath: string): string {
  return monaco.Uri.file(osPath).toString()
}


export function findModelByUri(uri: string): monaco.editor.ITextModel | null {
  const direct = monaco.editor.getModel(monaco.Uri.parse(uri))
  if (direct) return direct
  
  let target: string
  try {
    target = monaco.Uri.parse(uri).fsPath.toLowerCase()
  } catch {
    return null
  }
  for (const m of monaco.editor.getModels()) {
    if (m.uri.fsPath.toLowerCase() === target) return m
  }
  return null
}
