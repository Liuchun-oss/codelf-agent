import { createLspClient, type LspClient, type LspClientConfig } from './client'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { usePythonStore } from '@/stores/pythonStore'
import { APP_NAME } from '@shared/appConfig'




const getRoot = (): string | null | undefined => useWorkspaceStore.getState().workspace?.path

/**
 * 需要屏蔽的 basedpyright 诊断码。
 * 这些大多是"代码运行时正常、但静态类型推断不兼容"的误报
 * （第三方库 stub 不完整、Optional 推断、属性赋值类型不匹配等）。
 * 既用于客户端过滤，也下发到 diagnosticSeverityOverrides。
 */
const PYTHON_SUPPRESSED_CODES = [
  'reportUnusedCallResult',
  'reportUnknownMemberType',
  'reportUnknownArgumentType',
  'reportUnknownVariableType',
  'reportUnknownParameterType',
  'reportUnknownLambdaType',
  'reportMissingParameterType',
  'reportUnannotatedClassAttribute',
  'reportConstantRedefinition',
  'reportAny',
  'reportExplicitAny',
  'reportImplicitOverride',
  'reportMissingTypeStubs',
  'reportUnusedParameter',
  'reportOptionalMemberAccess',
  'reportOptionalSubscript',
  'reportOptionalCall',
  'reportOptionalIterable',
  'reportOptionalContains',
  'reportOptionalOperand',
  'reportAttributeAccessIssue',
  'reportArgumentType',
  'reportAssignmentType',
  'reportCallIssue',
  'reportIndexIssue',
  'reportReturnType',
  'reportGeneralTypeIssues',
  'reportRedeclaration',
  'reportIncompatibleMethodOverride',
  'reportIncompatibleVariableOverride',
  'reportPossiblyUnbound',
  'reportPossiblyUnboundVariable',
  'reportOperatorIssue',
  'reportUninitializedInstanceVariable',
  'reportTypedDictNotRequiredAccess',
  'reportInvalidTypeForm',
  'reportInvalidTypeArguments',
  'reportPrivateImportUsage',
  'reportPrivateUsage',
  'reportSelfClsParameterName',
  'reportCallInDefaultInitializer',
  'reportUnnecessaryComparison',
  'reportUnnecessaryContains',
  'reportUnnecessaryCast',
  'reportUnnecessaryIsInstance',
  'reportUnboundVariable',
  'reportNoOverloadImplementation',
  'reportInconsistentOverload',
  'reportOverlappingOverload',
  'reportInvalidStringEscapeSequence',
  'reportImplicitStringConcatenation',
  'reportDeprecated'
]

const PYTHON_SEVERITY_OVERRIDES: Record<string, string> = {
  ...Object.fromEntries(PYTHON_SUPPRESSED_CODES.map((code) => [code, 'none'])),
  // 缺依赖默认是 warning，提升为 error，让切换到缺包环境时有醒目红线
  reportMissingImports: 'error',
  reportMissingModuleSource: 'error'
}

/**
 * Python 诊断白名单：只保留这些"会导致代码真正运行失败"的诊断，
 * 其余所有 basedpyright 类型推断类报错（report*）全部丢弃。
 * 这样无需逐个枚举要屏蔽的码，从根本上避免误报红线。
 */
const PYTHON_ALLOWED_CODES = [
  'reportUndefinedVariable',
  'reportMissingImports',
  'reportMissingModuleSource',
  'reportSyntaxError'
]

let cachedTsdkPath: string | null = null


void window.lc.lsp.tsdkPath().then((p) => {
  cachedTsdkPath = p
})

const DEFS: LspClientConfig[] = [
  {
    serverId: 'typescript',
    languages: ['typescript', 'javascript', 'tsx', 'jsx'],
    markerOwner: 'typescript',
    requiresWorkspace: true,
    semanticTokens: true,
    getWorkspaceRoot: getRoot,
    buildInitOptions: () => ({
      hostInfo: APP_NAME,
      preferences: {
        includeCompletionsForModuleExports: true,
        includeCompletionsWithInsertText: true
      }
    })
  },
  {
    serverId: 'python',
    languages: ['python'],
    markerOwner: 'pyright',
    diagnosticSource: 'Pylance',
    semanticTokens: true,
    
    suppressDiagnosticCodes: PYTHON_SUPPRESSED_CODES,
    allowOnlyDiagnosticCodes: PYTHON_ALLOWED_CODES,
    getWorkspaceRoot: getRoot,
    buildInitOptions: () => ({
      disableTaggedHints: false
    }),
    getConfiguration: (section) => {
      const selected = usePythonStore.getState().selected
      const pythonPath = selected?.executable || ''

      const analysis = {
        diagnosticMode: 'openFilesOnly',
        typeCheckingMode: 'off',
        useLibraryCodeForTypes: true,
        autoSearchPaths: true,
        extraPaths: [],
        
        
        diagnosticSeverityOverrides: PYTHON_SEVERITY_OVERRIDES
      }
      const pythonSection = { analysis, pythonPath }
      switch (section) {
        case 'python':
        case 'basedpyright':
        case 'pyright':
          return pythonSection
        case undefined:
          
          return {
            python: pythonSection,
            basedpyright: pythonSection,
            pyright: pythonSection
          }
        default:
          return {}
      }
    }
  },
  {
    serverId: 'css',
    languages: ['css', 'scss', 'less'],
    markerOwner: 'css',
    semanticTokens: false,
    getWorkspaceRoot: getRoot
  },
  {
    serverId: 'html',
    languages: ['html'],
    markerOwner: 'html',
    semanticTokens: false,
    getWorkspaceRoot: getRoot
  },
  {
    serverId: 'json',
    languages: ['json'],
    markerOwner: 'json',
    semanticTokens: false,
    getWorkspaceRoot: getRoot
  },
  {
    serverId: 'yaml',
    languages: ['yaml'],
    markerOwner: 'yaml',
    semanticTokens: false,
    getWorkspaceRoot: getRoot
  },
  {
    serverId: 'vue',
    languages: ['vue'],
    markerOwner: 'vue',
    requiresWorkspace: false,
    semanticTokens: true,
    getWorkspaceRoot: getRoot,
    buildInitOptions: () => ({
      typescript: {
        tsdk: cachedTsdkPath ?? ''
      }
    })
  }
]

interface Entry {
  config: LspClientConfig
  client: LspClient
}

const entries: Entry[] = DEFS.map((config) => ({ config, client: createLspClient(config) }))
const byLanguage = new Map<string, Entry>()
for (const e of entries) for (const lang of e.config.languages) byLanguage.set(lang, e)


export function startLspForLanguage(language: string): void {
  void byLanguage.get(language)?.client.start()
}


export function startInitialLsp(): void {
  for (const e of entries) if (e.config.requiresWorkspace) void e.client.start()
}


export function restartWorkspaceLsp(): void {
  for (const e of entries) {
    if (e.config.requiresWorkspace || e.client.isStarted()) void e.client.restart()
  }
}


export function restartPythonLsp(): void {
  const entry = byLanguage.get('python')
  if (entry?.client.isStarted()) void entry.client.restart()
}


export function stopAllLsp(): void {
  for (const e of entries) void e.client.stop()
}
