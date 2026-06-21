import * as monaco from 'monaco-editor'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import type { DiagnosticEntry } from '@shared/diagnostics'

function severityLabel(s: monaco.MarkerSeverity): DiagnosticEntry['severity'] {
  if (s === monaco.MarkerSeverity.Error) return 'error'
  if (s === monaco.MarkerSeverity.Warning) return 'warning'
  if (s === monaco.MarkerSeverity.Info) return 'info'
  return 'hint'
}


export function exportWorkspaceDiagnostics(): DiagnosticEntry[] {
  const root = useWorkspaceStore.getState().workspace?.path
  if (!root) return []

  const rootNorm = root.replace(/\\/g, '/').toLowerCase()
  const out: DiagnosticEntry[] = []

  for (const model of monaco.editor.getModels()) {
    const uri = model.uri
    if (uri.scheme !== 'file') continue
    const fsPath = uri.fsPath
    if (!fsPath) continue
    const norm = fsPath.replace(/\\/g, '/').toLowerCase()
    if (norm !== rootNorm && !norm.startsWith(rootNorm + '/')) continue

    const markers = monaco.editor.getModelMarkers({ resource: uri })
    for (const m of markers) {
      out.push({
        path: fsPath,
        line: m.startLineNumber,
        column: m.startColumn,
        severity: severityLabel(m.severity),
        message: m.message,
        source: m.source
      })
    }
  }

  out.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column)
  return out
}
