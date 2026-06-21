import * as monaco from 'monaco-editor'
import type { LspServerId } from '@/types'
import { findModelByUri } from './uri'
import { ensureModelsForLocations } from './ensureMonacoModel'
import { toast } from '@/stores/toastStore'
import { APP_NAME, APP_VERSION } from '@shared/appConfig'

type Json = any

const REQUEST_TIMEOUT = 8000

export interface LspClientConfig {
  serverId: LspServerId
  languages: string[]
  markerOwner: string
  diagnosticSource?: string
  
  requiresWorkspace?: boolean
  
  semanticTokens?: boolean
  
  diagnostics?: boolean
  
  suppressDiagnosticCodes?: string[]
  /**
   * 诊断白名单：若设置，则只保留 code 命中该列表的诊断，其余全部丢弃。
   * 优先级高于 suppressDiagnosticCodes。用于只保留会导致运行失败的真错误。
   */
  allowOnlyDiagnosticCodes?: string[]
  getWorkspaceRoot: () => string | null | undefined
  buildInitOptions?: (rootPath: string | null) => Json
  getConfiguration?: (section: string | undefined, rootPath: string | null) => Json
}


const LSP_TOKEN_TYPES = [
  'namespace',
  'type',
  'class',
  'enum',
  'interface',
  'struct',
  'typeParameter',
  'parameter',
  'variable',
  'property',
  'enumMember',
  'event',
  'function',
  'method',
  'macro',
  'keyword',
  'modifier',
  'comment',
  'string',
  'number',
  'regexp',
  'operator',
  'decorator'
]

const LSP_TOKEN_MODIFIERS = [
  'declaration',
  'definition',
  'readonly',
  'static',
  'deprecated',
  'abstract',
  'async',
  'modification',
  'documentation',
  'defaultLibrary'
]

export interface LspClient {
  start: () => Promise<void>
  stop: () => Promise<void>
  restart: () => Promise<void>
  isStarted: () => boolean
}

export function createLspClient(config: LspClientConfig): LspClient {
  let started = false
  let initialized = false
  let nextId = 1
  let providersRegistered = false

  const pending = new Map<
    number,
    { resolve: (v: Json) => void; timer: ReturnType<typeof setTimeout> }
  >()
  const openDocs = new Map<string, number>()
  const hooked = new WeakSet<monaco.editor.ITextModel>()
  const disposables: Array<{ dispose(): void }> = []
  let offMessage: (() => void) | null = null
  let offClosed: (() => void) | null = null
  let semanticLegend: monaco.languages.SemanticTokensLegend | null = null

  const languageSet = new Set(config.languages)
  const diagSource = config.diagnosticSource ?? config.markerOwner

  function lsp() {
    return window.lc.lsp
  }

  function isSupported(model: monaco.editor.ITextModel): boolean {
    return languageSet.has(model.getLanguageId())
  }

  
  function lspLanguageId(model: monaco.editor.ITextModel): string {
    const path = model.uri.fsPath.toLowerCase()
    if (path.endsWith('.tsx')) return 'typescriptreact'
    if (path.endsWith('.jsx')) return 'javascriptreact'
    if (path.endsWith('.ts') || path.endsWith('.mts') || path.endsWith('.cts')) return 'typescript'
    if (path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs')) return 'javascript'
    return model.getLanguageId()
  }

  function ready(): boolean {
    return started && initialized
  }

  function sendNotification(method: string, params: Json): void {
    lsp().send(config.serverId, { jsonrpc: '2.0', method, params })
  }

  function sendRequest(method: string, params: Json): Promise<Json> {
    const id = nextId++
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (pending.delete(id)) resolve(null)
      }, REQUEST_TIMEOUT)
      pending.set(id, { resolve, timer })
      lsp().send(config.serverId, { jsonrpc: '2.0', id, method, params })
    })
  }

  function reply(id: number, result: Json): void {
    lsp().send(config.serverId, { jsonrpc: '2.0', id, result })
  }

  function onMessage(msg: Json): void {
    if (!msg || typeof msg !== 'object') return

    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = pending.get(msg.id)
      if (p) {
        pending.delete(msg.id)
        clearTimeout(p.timer)
        p.resolve(msg.error ? null : msg.result)
      }
      return
    }

    if (msg.id !== undefined && typeof msg.method === 'string') {
      handleServerRequest(msg)
      return
    }

    if (typeof msg.method === 'string' && msg.method === 'textDocument/publishDiagnostics') {
      applyDiagnostics(msg.params)
    } else if (typeof msg.method === 'string' && msg.method === 'workspace/semanticTokens/refresh') {
      for (const model of monaco.editor.getModels()) {
        if (isSupported(model)) {
          monaco.editor.setModelLanguage(model, model.getLanguageId())
        }
      }
    }
  }

  function handleServerRequest(msg: Json): void {
    switch (msg.method) {
      case 'workspace/configuration': {
        const items: Json[] = msg.params?.items ?? []
        const rootPath = config.getWorkspaceRoot() ?? null
        reply(
          msg.id,
          items.map((item) => config.getConfiguration?.(item?.section, rootPath) ?? {})
        )
        return
      }
      case 'client/registerCapability':
      case 'client/unregisterCapability':
      case 'window/workDoneProgress/create':
      case 'workspace/semanticTokens/refresh':
      case 'workspace/inlayHint/refresh':
      case 'workspace/diagnostic/refresh':
      case 'workspace/codeLens/refresh':
        reply(msg.id, null)
        return
      default:
        reply(msg.id, null)
    }
  }

  function lspRangeToMonaco(r: Json): monaco.IRange {
    return {
      startLineNumber: r.start.line + 1,
      startColumn: r.start.character + 1,
      endLineNumber: r.end.line + 1,
      endColumn: r.end.character + 1
    }
  }

  function lspTextEdit(edit: Json): { range: monaco.IRange; text: string } {
    return { range: lspRangeToMonaco(edit.range), text: edit.newText ?? '' }
  }

  
  function toWorkspaceEdit(lspEdit: Json): monaco.languages.WorkspaceEdit {
    const edits: monaco.languages.IWorkspaceTextEdit[] = []
    if (lspEdit?.changes) {
      for (const uri of Object.keys(lspEdit.changes)) {
        for (const e of lspEdit.changes[uri]) {
          edits.push({ resource: monaco.Uri.parse(uri), textEdit: lspTextEdit(e), versionId: undefined })
        }
      }
    }
    if (Array.isArray(lspEdit?.documentChanges)) {
      for (const dc of lspEdit.documentChanges) {
        if (dc?.textDocument?.uri && Array.isArray(dc.edits)) {
          for (const e of dc.edits) {
            edits.push({
              resource: monaco.Uri.parse(dc.textDocument.uri),
              textEdit: lspTextEdit(e),
              versionId: undefined
            })
          }
        }
      }
    }
    return { edits }
  }

  const K = monaco.languages.CompletionItemKind
  const COMPLETION_KIND: Record<number, monaco.languages.CompletionItemKind> = {
    1: K.Text,
    2: K.Method,
    3: K.Function,
    4: K.Constructor,
    5: K.Field,
    6: K.Variable,
    7: K.Class,
    8: K.Interface,
    9: K.Module,
    10: K.Property,
    11: K.Unit,
    12: K.Value,
    13: K.Enum,
    14: K.Keyword,
    15: K.Snippet,
    16: K.Color,
    17: K.File,
    18: K.Reference,
    19: K.Folder,
    20: K.EnumMember,
    21: K.Constant,
    22: K.Struct,
    23: K.Event,
    24: K.Operator,
    25: K.TypeParameter
  }

  function mapSeverity(sev: number | undefined): monaco.MarkerSeverity {
    switch (sev) {
      case 1:
        return monaco.MarkerSeverity.Error
      case 2:
        return monaco.MarkerSeverity.Warning
      case 3:
        return monaco.MarkerSeverity.Info
      case 4:
        return monaco.MarkerSeverity.Hint
      default:
        return monaco.MarkerSeverity.Info
    }
  }

  function mapDoc(doc: Json): string | monaco.IMarkdownString | undefined {
    if (!doc) return undefined
    if (typeof doc === 'string') return doc
    if (typeof doc.value === 'string') {
      return doc.kind === 'markdown' ? { value: doc.value } : doc.value
    }
    return undefined
  }

  function markedToString(c: Json): string {
    if (typeof c === 'string') return c
    if (c && typeof c.value === 'string') return c.value
    return ''
  }

  function didOpen(model: monaco.editor.ITextModel): void {
    const uri = model.uri.toString()
    if (openDocs.has(uri)) return
    openDocs.set(uri, 1)
    sendNotification('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: lspLanguageId(model),
        version: 1,
        text: model.getValue()
      }
    })
  }

  function didChange(model: monaco.editor.ITextModel, e: monaco.editor.IModelContentChangedEvent): void {
    const uri = model.uri.toString()
    if (!openDocs.has(uri)) {
      didOpen(model)
      return
    }
    const version = (openDocs.get(uri) ?? 1) + 1
    openDocs.set(uri, version)
    const contentChanges = e.changes.map((c) => ({
      range: {
        start: { line: c.range.startLineNumber - 1, character: c.range.startColumn - 1 },
        end: { line: c.range.endLineNumber - 1, character: c.range.endColumn - 1 }
      },
      text: c.text
    }))
    sendNotification('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges
    })
  }

  function didClose(model: monaco.editor.ITextModel): void {
    const uri = model.uri.toString()
    if (!openDocs.has(uri)) return
    openDocs.delete(uri)
    sendNotification('textDocument/didClose', { textDocument: { uri } })
  }

  function hookModel(model: monaco.editor.ITextModel): void {
    if (hooked.has(model)) return
    hooked.add(model)

    disposables.push(
      model.onDidChangeContent((e) => {
        if (!ready() || !isSupported(model)) return
        didChange(model, e)
      })
    )
    disposables.push(
      model.onDidChangeLanguage(() => {
        if (!ready()) return
        if (isSupported(model)) {
          if (config.diagnostics === false) clearDiagnostics(model)
          didOpen(model)
        } else didClose(model)
      })
    )
    model.onWillDispose(() => {
      if (ready()) didClose(model)
      hooked.delete(model)
    })

    if (ready() && isSupported(model)) {
      if (config.diagnostics === false) clearDiagnostics(model)
      didOpen(model)
    }
  }

  function ensureOpen(model: monaco.editor.ITextModel): void {
    if (!openDocs.has(model.uri.toString())) didOpen(model)
  }

  function clearDiagnostics(model: monaco.editor.ITextModel): void {
    monaco.editor.setModelMarkers(model, config.markerOwner, [])
  }

  function applyDiagnostics(params: Json): void {
    if (!params || typeof params.uri !== 'string') return
    const model = findModelByUri(params.uri)
    if (!model) return
    if (config.diagnostics === false) {
      clearDiagnostics(model)
      return
    }
    const diags: Json[] = params.diagnostics ?? []
    const suppress = config.suppressDiagnosticCodes
    const allowOnly = config.allowOnlyDiagnosticCodes
    const markers: monaco.editor.IMarkerData[] = diags
      .filter((d) => {
        const code = typeof d.code === 'object' && d.code ? String(d.code.value) : String(d.code ?? '')
        if (allowOnly && allowOnly.length > 0) return allowOnly.includes(code)
        if (!suppress || suppress.length === 0) return true
        return !suppress.includes(code)
      })
      .map((d) => {
        const r = lspRangeToMonaco(d.range)
        return {
          severity: mapSeverity(d.severity),
          message: d.message,
          source: d.source ?? diagSource,
          code:
            d.code == null
              ? undefined
              : typeof d.code === 'object'
                ? String(d.code.value)
                : String(d.code),
          startLineNumber: r.startLineNumber,
          startColumn: r.startColumn,
          endLineNumber: r.endLineNumber,
          endColumn: r.endColumn
        }
      })
    monaco.editor.setModelMarkers(model, config.markerOwner, markers)
  }

  function mapCompletionItem(it: Json, defaultRange: monaco.IRange): monaco.languages.CompletionItem {
    const isSnippet = it.insertTextFormat === 2
    let insertText: string = it.insertText ?? it.label
    let range: monaco.IRange = defaultRange
    const te = it.textEdit
    if (te) {
      insertText = te.newText ?? insertText
      const r = te.range ?? te.replace ?? te.insert
      if (r) range = lspRangeToMonaco(r)
    }
    const mapped: monaco.languages.CompletionItem & { __lsp?: Json } = {
      label: it.label,
      kind: COMPLETION_KIND[it.kind] ?? K.Text,
      insertText,
      insertTextRules: isSnippet
        ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
        : undefined,
      detail: it.detail,
      documentation: mapDoc(it.documentation),
      sortText: it.sortText,
      filterText: it.filterText,
      range,
      additionalTextEdits: Array.isArray(it.additionalTextEdits)
        ? it.additionalTextEdits.map(lspTextEdit)
        : undefined
    }
    
    mapped.__lsp = it
    return mapped
  }

  function mapLocations(result: Json): monaco.languages.Definition | null {
    if (!result) return null
    const arr: Json[] = Array.isArray(result) ? result : [result]
    const out: monaco.languages.Location[] = []
    for (const loc of arr) {
      const uri: string | undefined = loc.uri ?? loc.targetUri
      const range: Json = loc.range ?? loc.targetSelectionRange ?? loc.targetRange
      if (!uri || !range) continue
      out.push({ uri: monaco.Uri.parse(uri), range: lspRangeToMonaco(range) })
    }
    return out
  }

  function registerProviders(): void {
    if (providersRegistered) return
    providersRegistered = true

    for (const language of config.languages) {
      disposables.push(
        monaco.languages.registerCompletionItemProvider(language, {
          triggerCharacters: ['.', '(', '[', '"', "'", '<', '@', '/'],
          async provideCompletionItems(model, position) {
            if (!ready() || !isSupported(model)) return { suggestions: [] }
            ensureOpen(model)
            const result = await sendRequest('textDocument/completion', {
              textDocument: { uri: model.uri.toString() },
              position: { line: position.lineNumber - 1, character: position.column - 1 }
            })
            const items: Json[] = Array.isArray(result) ? result : result?.items ?? []
            const word = model.getWordUntilPosition(position)
            const defaultRange = new monaco.Range(
              position.lineNumber,
              word.startColumn,
              position.lineNumber,
              word.endColumn
            )
            return {
              suggestions: items.map((it) => mapCompletionItem(it, defaultRange)),
              incomplete: !!result?.isIncomplete
            }
          },
          
          async resolveCompletionItem(item) {
            const raw = (item as monaco.languages.CompletionItem & { __lsp?: Json }).__lsp
            if (!ready() || !raw) return item
            const resolved = await sendRequest('completionItem/resolve', raw)
            if (!resolved) return item
            if (resolved.documentation) item.documentation = mapDoc(resolved.documentation)
            if (resolved.detail) item.detail = resolved.detail
            if (Array.isArray(resolved.additionalTextEdits)) {
              item.additionalTextEdits = resolved.additionalTextEdits.map(lspTextEdit)
            }
            return item
          }
        })
      )

      disposables.push(
        monaco.languages.registerHoverProvider(language, {
          async provideHover(model, position) {
            if (!ready() || !isSupported(model)) return null
            ensureOpen(model)
            const result = await sendRequest('textDocument/hover', {
              textDocument: { uri: model.uri.toString() },
              position: { line: position.lineNumber - 1, character: position.column - 1 }
            })
            if (!result || !result.contents) return null
            const contents = Array.isArray(result.contents)
              ? result.contents.map(markedToString)
              : [markedToString(result.contents)]
            const value = contents.filter(Boolean).join('\n\n')
            if (!value) return null
            return {
              contents: [{ value }],
              range: result.range ? lspRangeToMonaco(result.range) : undefined
            }
          }
        })
      )

      disposables.push(
        monaco.languages.registerSignatureHelpProvider(language, {
          signatureHelpTriggerCharacters: ['(', ','],
          signatureHelpRetriggerCharacters: [')'],
          async provideSignatureHelp(model, position) {
            if (!ready() || !isSupported(model)) return null
            ensureOpen(model)
            const result = await sendRequest('textDocument/signatureHelp', {
              textDocument: { uri: model.uri.toString() },
              position: { line: position.lineNumber - 1, character: position.column - 1 }
            })
            if (!result || !Array.isArray(result.signatures) || result.signatures.length === 0) {
              return null
            }
            return {
              value: {
                signatures: result.signatures.map((s: Json) => ({
                  label: s.label,
                  documentation: mapDoc(s.documentation),
                  parameters: (s.parameters ?? []).map((p: Json) => ({
                    label: p.label,
                    documentation: mapDoc(p.documentation)
                  }))
                })),
                activeSignature: result.activeSignature ?? 0,
                activeParameter: result.activeParameter ?? 0
              },
              dispose() {
                
              }
            }
          }
        })
      )

      disposables.push(
        monaco.languages.registerDefinitionProvider(language, {
          async provideDefinition(model, position) {
            if (!ready() || !isSupported(model)) return null
            ensureOpen(model)
            const result = await sendRequest('textDocument/definition', {
              textDocument: { uri: model.uri.toString() },
              position: { line: position.lineNumber - 1, character: position.column - 1 }
            })
            const mapped = mapLocations(result)
            await ensureModelsForLocations(mapped)
            return mapped
          }
        })
      )

      disposables.push(
        monaco.languages.registerReferenceProvider(language, {
          async provideReferences(model, position, context) {
            if (!ready() || !isSupported(model)) return null
            ensureOpen(model)
            const result = await sendRequest('textDocument/references', {
              textDocument: { uri: model.uri.toString() },
              position: { line: position.lineNumber - 1, character: position.column - 1 },
              context: { includeDeclaration: context.includeDeclaration }
            })
            const locs = mapLocations(result)
            await ensureModelsForLocations(locs)
            return Array.isArray(locs) ? locs : locs ? [locs] : null
          }
        })
      )

      disposables.push(
        monaco.languages.registerRenameProvider(language, {
          async provideRenameEdits(model, position, newName) {
            if (!ready() || !isSupported(model)) return null
            ensureOpen(model)
            const result = await sendRequest('textDocument/rename', {
              textDocument: { uri: model.uri.toString() },
              position: { line: position.lineNumber - 1, character: position.column - 1 },
              newName
            })
            if (!result) return { edits: [], rejectReason: '无法重命名此符号' }
            return toWorkspaceEdit(result)
          }
        })
      )

      disposables.push(
        monaco.languages.registerDocumentSymbolProvider(language, {
          async provideDocumentSymbols(model) {
            if (!ready() || !isSupported(model)) return null
            ensureOpen(model)
            const result = await sendRequest('textDocument/documentSymbol', {
              textDocument: { uri: model.uri.toString() }
            })
            if (!Array.isArray(result)) return null
            return mapDocumentSymbols(result)
          }
        })
      )

      disposables.push(
        monaco.languages.registerDocumentFormattingEditProvider(language, {
          async provideDocumentFormattingEdits(model, options) {
            if (!ready() || !isSupported(model)) return null
            ensureOpen(model)
            const result = await sendRequest('textDocument/formatting', {
              textDocument: { uri: model.uri.toString() },
              options: {
                tabSize: options.tabSize,
                insertSpaces: options.insertSpaces,
                trimTrailingWhitespace: true,
                insertFinalNewline: true
              }
            })
            if (!Array.isArray(result)) return null
            return result.map(lspTextEdit)
          }
        })
      )

      disposables.push(
        monaco.languages.registerCodeActionProvider(language, {
          async provideCodeActions(model, range, context) {
            if (!ready() || !isSupported(model)) return { actions: [], dispose() {} }
            ensureOpen(model)
            const diagnostics = context.markers.map((m) => ({
              range: {
                start: { line: m.startLineNumber - 1, character: m.startColumn - 1 },
                end: { line: m.endLineNumber - 1, character: m.endColumn - 1 }
              },
              message: m.message,
              severity: m.severity === monaco.MarkerSeverity.Error ? 1 : 2,
              code: m.code
            }))
            const result = await sendRequest('textDocument/codeAction', {
              textDocument: { uri: model.uri.toString() },
              range: {
                start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
                end: { line: range.endLineNumber - 1, character: range.endColumn - 1 }
              },
              context: { diagnostics, only: undefined }
            })
            const items: Json[] = Array.isArray(result) ? result : []
            const actions: monaco.languages.CodeAction[] = []
            for (let raw of items) {
              
              if (raw.edit === undefined && raw.data !== undefined) {
                const resolved = await sendRequest('codeAction/resolve', raw)
                if (resolved) raw = resolved
              }
              if (!raw.edit) continue
              actions.push({
                title: raw.title,
                kind: raw.kind,
                isPreferred: raw.isPreferred,
                diagnostics: undefined,
                edit: toWorkspaceEdit(raw.edit)
              })
            }
            return { actions, dispose() {} }
          }
        })
      )
    }
  }

  function mapSymbolKind(kind: number): monaco.languages.SymbolKind {
    
    const S = monaco.languages.SymbolKind
    const table: Record<number, monaco.languages.SymbolKind> = {
      1: S.File, 2: S.Module, 3: S.Namespace, 4: S.Package, 5: S.Class,
      6: S.Method, 7: S.Property, 8: S.Field, 9: S.Constructor, 10: S.Enum,
      11: S.Interface, 12: S.Function, 13: S.Variable, 14: S.Constant, 15: S.String,
      16: S.Number, 17: S.Boolean, 18: S.Array, 19: S.Object, 20: S.Key,
      21: S.Null, 22: S.EnumMember, 23: S.Struct, 24: S.Event, 25: S.Operator,
      26: S.TypeParameter
    }
    return table[kind] ?? S.Variable
  }

  function mapDocumentSymbols(items: Json[]): monaco.languages.DocumentSymbol[] {
    return items.map((s): monaco.languages.DocumentSymbol => {
      
      const range = s.range ?? (s.location ? s.location.range : undefined)
      const selRange = s.selectionRange ?? range
      return {
        name: s.name,
        detail: s.detail ?? '',
        kind: mapSymbolKind(s.kind),
        tags: s.deprecated ? [monaco.languages.SymbolTag.Deprecated] : [],
        range: range ? lspRangeToMonaco(range) : { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
        selectionRange: selRange ? lspRangeToMonaco(selRange) : { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
        children: Array.isArray(s.children) ? mapDocumentSymbols(s.children) : undefined
      }
    })
  }

  function registerSemanticTokensProvider(): void {
    if (!semanticLegend) return
    for (const language of config.languages) {
      disposables.push(
        monaco.languages.registerDocumentSemanticTokensProvider(language, {
          getLegend: () => semanticLegend!,
          async provideDocumentSemanticTokens(model) {
            if (!ready() || !isSupported(model)) return null
            ensureOpen(model)
            const result = await sendRequest('textDocument/semanticTokens/full', {
              textDocument: { uri: model.uri.toString() }
            })
            if (!result?.data || !Array.isArray(result.data)) return null
            return { data: Uint32Array.from(result.data) }
          },
          releaseDocumentSemanticTokens() {
            
          }
        })
      )
    }
  }

  function initializeParams(rootPath: string | null): Json {
    const rootUri = rootPath ? monaco.Uri.file(rootPath).toString() : null
    return {
      processId: null,
      clientInfo: { name: APP_NAME, version: APP_VERSION },
      locale: 'zh-cn',
      rootUri,
      workspaceFolders: rootUri ? [{ uri: rootUri, name: 'workspace' }] : null,
      capabilities: {
        workspace: {
          configuration: true,
          workspaceFolders: true,
          didChangeConfiguration: { dynamicRegistration: true }
        },
        textDocument: {
          synchronization: { dynamicRegistration: false, didSave: false },
          publishDiagnostics: { relatedInformation: true },
          completion: {
            completionItem: {
              snippetSupport: true,
              documentationFormat: ['markdown', 'plaintext'],
              insertReplaceSupport: false,
              resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits'] }
            }
          },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          signatureHelp: {
            signatureInformation: {
              documentationFormat: ['markdown', 'plaintext'],
              parameterInformation: { labelOffsetSupport: true }
            }
          },
          definition: { linkSupport: true },
          references: {},
          rename: { prepareSupport: false },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          formatting: {},
          codeAction: {
            codeActionLiteralSupport: {
              codeActionKind: {
                valueSet: ['quickfix', 'refactor', 'source', 'source.organizeImports']
              }
            },
            resolveSupport: { properties: ['edit'] },
            dataSupport: true
          },
          ...(config.semanticTokens
            ? {
                semanticTokens: {
                  dynamicRegistration: false,
                  tokenTypes: LSP_TOKEN_TYPES,
                  tokenModifiers: LSP_TOKEN_MODIFIERS,
                  formats: ['relative'],
                  requests: {
                    range: false,
                    full: { delta: false }
                  }
                }
              }
            : {})
        }
      },
      initializationOptions: config.buildInitOptions?.(rootPath) ?? {}
    }
  }

  async function cleanupClientState(): Promise<void> {
    for (const d of disposables.splice(0)) {
      try {
        d.dispose()
      } catch {
        
      }
    }
    for (const [, p] of pending) clearTimeout(p.timer)
    pending.clear()
    openDocs.clear()
    offMessage?.()
    offClosed?.()
    offMessage = null
    offClosed = null
    started = false
    initialized = false
    providersRegistered = false
    semanticLegend = null
  }

  let reconnectAttempts = 0
  let lastReconnectTs = 0
  const MAX_RECONNECT = 3
  const BASE_DELAY = 400
  const RECONNECT_COOLDOWN = 10_000

  async function handleServerClosed(): Promise<void> {
    if (!started) return
    await cleanupClientState()

    const now = Date.now()
    if (now - lastReconnectTs > RECONNECT_COOLDOWN) {
      reconnectAttempts = 0
    }
    reconnectAttempts++
    lastReconnectTs = now

    if (reconnectAttempts > MAX_RECONNECT) {
      toast.error(`${config.serverId} 语言服务多次断开，已停止自动重连`)
      return
    }

    const delay = BASE_DELAY * Math.pow(2, reconnectAttempts - 1)
    toast.warn(`${config.serverId} 语言服务已断开，正在重新连接…`)
    setTimeout(() => void start(), delay)
  }

  async function start(): Promise<void> {
    if (started) return

    const workspaceRoot = config.getWorkspaceRoot() ?? null
    if (config.requiresWorkspace && !workspaceRoot) return

    started = true

    offMessage = lsp().onMessage(({ serverId, message }) => {
      if (serverId !== config.serverId) return
      onMessage(message)
    })
    offClosed = lsp().onClosed(({ serverId }) => {
      if (serverId !== config.serverId) return
      void handleServerClosed()
    })

    const res = await lsp().start(config.serverId, workspaceRoot ?? undefined)
    if (!res.ok) {
      started = false
      offMessage?.()
      offClosed?.()
      offMessage = null
      offClosed = null
      console.warn(`[LSP:${config.serverId}] 语言服务器不可用：`, res.error)
      if (res.error) toast.warn(`${config.serverId} 语言服务不可用：${res.error}`)
      return
    }

    const initResult = await sendRequest('initialize', initializeParams(workspaceRoot))
    sendNotification('initialized', {})

    if (config.semanticTokens && initResult?.capabilities?.semanticTokensProvider?.legend) {
      const legend = initResult.capabilities.semanticTokensProvider.legend
      semanticLegend = {
        tokenTypes: legend.tokenTypes ?? LSP_TOKEN_TYPES,
        tokenModifiers: legend.tokenModifiers ?? LSP_TOKEN_MODIFIERS
      }
    }

    initialized = true
    reconnectAttempts = 0

    
    
    if (config.getConfiguration) {
      const settings = config.getConfiguration(undefined, workspaceRoot)
      sendNotification('workspace/didChangeConfiguration', { settings })
    }

    registerProviders()
    registerSemanticTokensProvider()
    disposables.push(monaco.editor.onDidCreateModel((m) => hookModel(m)))
    for (const m of monaco.editor.getModels()) {
      hookModel(m)
      if (config.diagnostics === false && isSupported(m)) clearDiagnostics(m)
    }
  }

  async function stop(): Promise<void> {
    if (!started) return
    await cleanupClientState()
    await lsp().stop(config.serverId)
  }

  async function restart(): Promise<void> {
    await stop()
    await start()
  }

  return { start, stop, restart, isStarted: () => started }
}
