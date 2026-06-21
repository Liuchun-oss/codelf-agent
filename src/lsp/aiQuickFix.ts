import * as monaco from 'monaco-editor'
import { getEditorInstance } from '@/components/Editor/editorBridge'
import { triggerAiFix } from '@/components/Editor/inlineEditController'
import { LSP_FIX_COMMAND_ID } from '@shared/appConfig'

const COMMAND_ID = LSP_FIX_COMMAND_ID

interface FixArgs {
  uri: string
  startLineNumber: number
  endLineNumber: number
  messages: string[]
}

let registered = false

export function setupAiQuickFix(): void {
  if (registered) return
  registered = true

  monaco.editor.registerCommand(COMMAND_ID, (_accessor, ...args: unknown[]) => {
    const a = args[0] as FixArgs | undefined
    if (!a) return
    const ed = getEditorInstance()
    if (!ed) return
    const model = ed.getModel()
    if (!model || model.uri.toString() !== a.uri) return
    triggerAiFix(
      ed,
      { startLineNumber: a.startLineNumber, endLineNumber: a.endLineNumber },
      a.messages
    )
  })

  monaco.languages.registerCodeActionProvider(
    { pattern: '**' },
    {
      provideCodeActions(model, range, context) {
        const markers = context.markers.filter(
          (m) =>
            m.severity === monaco.MarkerSeverity.Error ||
            m.severity === monaco.MarkerSeverity.Warning
        )
        if (markers.length === 0) return { actions: [], dispose() {} }

        let startLine = range.startLineNumber
        let endLine = range.endLineNumber
        for (const m of markers) {
          startLine = Math.min(startLine, m.startLineNumber)
          endLine = Math.max(endLine, m.endLineNumber)
        }
        const messages = Array.from(new Set(markers.map((m) => m.message))).slice(0, 8)

        const action: monaco.languages.CodeAction = {
          title: '✦ 用 AI 修复',
          kind: 'quickfix',
          isPreferred: false,
          diagnostics: markers,
          command: {
            id: COMMAND_ID,
            title: '用 AI 修复',
            arguments: [
              {
                uri: model.uri.toString(),
                startLineNumber: startLine,
                endLineNumber: endLine,
                messages
              } satisfies FixArgs
            ]
          }
        }
        return { actions: [action], dispose() {} }
      }
    },
    { providedCodeActionKinds: ['quickfix'] }
  )
}
