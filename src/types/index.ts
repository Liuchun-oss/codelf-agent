import type {
  AgentEvent,
  AiSendPayload,
  AuditEntry,
  DebugEventRecord,
  FileChangeDecision,
  PermissionDecision,
  UserQuestionResponse,
  PersistedSession,
  ProfileDraft,
  ProviderProfileSummary,
  AgentOpResult,
  RuleSummary,
  SaveProfileResult,
  TestConnectionResult,
  TestImageGenResult,
  SubagentTaskSummary,
  AgentDefinitionSummary,
  AgentTask,
  FimRequest,
  FimResult,
  InlineEditRequest,
  InlineEditResult
} from '@shared/agentTypes'
import type {
  GitStatus,
  GitDiffContent,
  GitBranch,
  GitFileStatus,
  GitOpResult,
  GitCommitResult,
  GitGenerateMessageResult
} from '@shared/gitTypes'
import type {
  PythonDiscoverResult,
  PythonSelectionResult
} from '@shared/pythonTypes'

export interface FileTreeNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileTreeNode[]
}

export interface Workspace {
  path: string
  name: string
}

export interface SemanticProgress {
  phase: 'scanning' | 'embedding' | 'done' | 'error'
  filesTotal: number
  filesProcessed: number
  chunksEmbedded: number
  error?: string
}

export interface KnowledgeProgress {
  phase: 'scanning' | 'parsing' | 'embedding' | 'done' | 'error'
  filesTotal: number
  filesProcessed: number
  chunksEmbedded: number
  currentFile?: string
  error?: string
  warnings?: Array<{ path: string; message: string }>
}

export interface KnowledgeImportResult {
  imported: number
  skipped: number
  failed: number
  failedFiles?: Array<{ path: string; reason: string }>
  warnings?: Array<{ path: string; message: string }>
}

export interface KnowledgeHealthCheck {
  ok: boolean
  issues: string[]
  stats: {
    orphanChunks: number
    orphanVectors: number
    inconsistentDocs: number
    modelMismatch: boolean
  }
  error?: string
}

export interface KnowledgeOutdatedDoc {
  id: string
  path: string
  title: string
  reason: 'modified' | 'deleted'
}

export interface KnowledgePreviewFile {
  path: string
  size: number
  status: 'new' | 'unchanged' | 'updated' | 'oversized' | 'empty' | 'unsupported'
  reason?: string
}

export interface KnowledgeBase {
  id: string
  name: string
  model: string
  dim: number
  createdAt: number
  docCount: number
  chunkCount: number
}

export interface KnowledgeDoc {
  id: string
  kbId: string
  path: string
  title: string
  hash: string
  chunkCount: number
  addedAt: number
}

export interface KnowledgeHit {
  docId: string
  path: string
  title: string
  heading: string
  ordinal: number
  text: string
  score: number
}

export type FileEncoding = 'utf8' | 'utf8bom' | 'utf16le' | 'utf16be'

export interface ReadFileResult {
  ok: boolean
  kind?: 'text' | 'image' | 'binary'
  content?: string
  dataUrl?: string
  encoding?: FileEncoding
  size?: number
  tooLarge?: boolean
  error?: string
}

export interface EditorTab {
  path: string
  name: string
  
  content: string
  
  savedContent?: string
  dirty: boolean
  language: string
  
  kind: 'text' | 'image' | 'diff' | 'browser'
  
  diffOriginal?: string
  diffModified?: string
  
  encoding?: FileEncoding
  
  dataUrl?: string
  
  /** For kind==='browser': the current URL loaded in the embedded browser. */
  url?: string
  
  size?: number
  
  pinned?: boolean
  
  untitled?: boolean
  cursorLine?: number
  cursorCol?: number
}

export interface OpResult {
  ok: boolean
  error?: string
  path?: string
  newPath?: string
}

export interface TerminalCreateResult {
  ok: boolean
  id?: string
  title?: string
  cwd?: string
  error?: string
}

export interface SearchOptions {
  caseSensitive?: boolean
  wholeWord?: boolean
  regex?: boolean
}

export interface SearchMatch {
  line: number
  col: number
  preview: string
  matchLength: number
}

export interface SearchFileResult {
  path: string
  matches: SearchMatch[]
}

export interface SearchResponse {
  ok: boolean
  results: SearchFileResult[]
  truncated: boolean
  error?: string
}

export type LspServerId = 'python' | 'typescript' | 'css' | 'html' | 'json' | 'yaml' | 'vue'

export interface LspStartResult {
  ok: boolean
  error?: string
}

export interface LcApi {
  
  tree: (rootPath: string, expanded: string[], showIgnored?: boolean) => Promise<FileTreeNode[]>
  readFile: (filePath: string) => Promise<string>
  readFileSafe: (filePath: string) => Promise<ReadFileResult>
  exists: (filePath: string) => Promise<boolean>
  rootFileNames: (dirPath: string) => Promise<string[]>
  listFiles: (rootPath: string) => Promise<string[]>
  writeFile: (filePath: string, content: string, encoding?: FileEncoding) => Promise<boolean>
  createFile: (parentPath: string, name: string) => Promise<OpResult>
  createFolder: (parentPath: string, name: string) => Promise<OpResult>
  deleteItem: (targetPath: string) => Promise<OpResult>
  renameItem: (oldPath: string, newName: string) => Promise<OpResult>
  moveItem: (src: string, destDir: string) => Promise<OpResult>
  copyItem: (src: string, destDir: string) => Promise<OpResult>
  revealItem: (targetPath: string) => Promise<boolean>
  openExternal: (target: string) => Promise<boolean>

  
  watch: (root: string) => Promise<boolean>
  unwatch: () => Promise<boolean>
  onFsEvent: (cb: (payload: { paths: string[] }) => void) => () => void
  onAgentWrote: (cb: (payload: { path: string }) => void) => () => void

  
  searchInFiles: (root: string, query: string, opts: SearchOptions) => Promise<SearchResponse>
  searchReplace: (
    paths: string[],
    query: string,
    replacement: string,
    opts: SearchOptions
  ) => Promise<{ ok: boolean; changed: number; error?: string }>

  
  semantic: {
    build: (root: string) => Promise<{ ok: boolean; error?: string }>
    cancel: () => Promise<boolean>
    update: (root: string, paths: string[]) => Promise<boolean>
    status: (root: string) => Promise<{
      indexed: boolean
      building: boolean
      fileCount: number
      chunkCount: number
      lastProgress?: SemanticProgress | null
    }>
    count: (root: string) => Promise<{ fileCount: number; indexed: boolean; autoLimit: number }>
    clear: (root: string) => Promise<boolean>
    onProgress: (cb: (p: SemanticProgress) => void) => () => void
  }

  
  knowledge: {
    probe: () => Promise<{ ok: boolean; error?: string }>
    listKbs: () => Promise<{ ok: boolean; error?: string; kbs: KnowledgeBase[] }>
    createKb: (name: string) => Promise<{ ok: boolean; error?: string; id?: string }>
    deleteKb: (kbId: string) => Promise<{ ok: boolean; error?: string }>
    listDocs: (kbId: string) => Promise<{ ok: boolean; error?: string; docs: KnowledgeDoc[] }>
    removeDoc: (docId: string) => Promise<{ ok: boolean; error?: string }>
    pickDocs: () => Promise<string[] | null>
    pickFolder: () => Promise<string | null>
    import: (kbId: string, paths: string[]) => Promise<{ ok: boolean; error?: string }>
    preview: (kbId: string, paths: string[]) => Promise<{ ok: boolean; files: KnowledgePreviewFile[]; error?: string }>
    cancel: () => Promise<boolean>
    status: () => Promise<{ importing: boolean; lastProgress?: KnowledgeProgress | null; lastResult?: KnowledgeImportResult | null }>
    rebuild: (kbId: string) => Promise<{ ok: boolean; error?: string }>
    query: (
      kbId: string,
      query: string,
      topK?: number
    ) => Promise<{ ok: boolean; hits: KnowledgeHit[]; error?: string }>
    healthCheck: (kbId: string) => Promise<KnowledgeHealthCheck>
    repair: (kbId: string) => Promise<{ ok: boolean; fixed?: number; error?: string }>
    export: (kbId: string) => Promise<{ ok: boolean; path?: string; error?: string }>
    findOutdated: (kbId: string) => Promise<{ ok: boolean; outdated: KnowledgeOutdatedDoc[]; error?: string }>
    importFromExport: (kbId: string) => Promise<{ ok: boolean; existing?: string[]; missing?: string[]; totalDocs?: number; error?: string }>
    onProgress: (cb: (p: KnowledgeProgress) => void) => () => void
  }

  
  git: {
    status: (cwd: string) => Promise<GitStatus>
    diff: (cwd: string, path: string, staged: boolean) => Promise<GitDiffContent>
    stage: (cwd: string, paths: string[]) => Promise<GitOpResult>
    unstage: (cwd: string, paths: string[]) => Promise<GitOpResult>
    stageAll: (cwd: string) => Promise<GitOpResult>
    unstageAll: (cwd: string) => Promise<GitOpResult>
    discard: (cwd: string, change: { path: string; status: GitFileStatus }) => Promise<GitOpResult>
    commit: (cwd: string, message: string, amend: boolean) => Promise<GitCommitResult>
    listBranches: (cwd: string) => Promise<GitBranch[]>
    checkoutBranch: (cwd: string, name: string, create: boolean) => Promise<GitOpResult>
    push: (cwd: string) => Promise<GitOpResult>
    pull: (cwd: string) => Promise<GitOpResult>
    generateMessage: (cwd: string) => Promise<GitGenerateMessageResult>
  }

  
  python: {
    discover: (workspaceRoot?: string) => Promise<PythonDiscoverResult>
    getSelected: (workspaceRoot?: string) => Promise<PythonSelectionResult>
    setSelected: (
      workspaceRoot: string | undefined,
      executable: string
    ) => Promise<PythonSelectionResult>
    browse: () => Promise<PythonSelectionResult>
  }

  
  env: {
    check: () => Promise<import('@shared/envCheckTypes').EnvCheckResult>
  }

  
  openFolder: () => Promise<Workspace | null>
  saveFileAs: (suggestedName: string, content: string) => Promise<OpResult>
  clipboardWriteText: (text: string) => Promise<boolean>
  clipboardReadText: () => Promise<string>

  
  terminalCreate: (cwd: string, cols?: number, rows?: number) => Promise<TerminalCreateResult>
  terminalWrite: (id: string, data: string) => Promise<boolean>
  terminalResize: (id: string, cols: number, rows: number) => Promise<boolean>
  terminalAttach: (id: string) => Promise<boolean>
  terminalKill: (id: string) => Promise<boolean>
  onTerminalData: (cb: (payload: { id: string; data: string }) => void) => () => void
  onTerminalExit: (cb: (payload: { id: string; exitCode?: number }) => void) => () => void

  
  runStart: (command: string, cwd: string) => Promise<{ ok: boolean; id?: string; error?: string }>
  runInput: (id: string, data: string) => Promise<boolean>
  runStop: (id: string) => Promise<boolean>
  onRunData: (
    cb: (payload: { id: string; data: string; stream: 'stdout' | 'stderr' }) => void
  ) => () => void
  onRunExit: (
    cb: (payload: { id: string; exitCode: number | null; signal?: string; error?: string }) => void
  ) => () => void

  
  aiSend: (payload: AiSendPayload) => Promise<AgentOpResult>
  aiStop: (sessionId?: string) => Promise<boolean>
  aiClearHistory: (sessionId?: string) => Promise<boolean>
  aiDeleteSession: (sessionId: string) => Promise<boolean>
  aiListSessions: (workspaceId?: string | null) => Promise<PersistedSession[]>
  aiLoadSession: (sessionId: string) => Promise<PersistedSession | null>
  aiSaveSession: (session: PersistedSession) => Promise<boolean>
  aiListRules: (workspaceRoot: string | null) => Promise<RuleSummary[]>
  aiListAgentTasks: (sessionId?: string) => Promise<AgentTask[]>
  aiListSubagentTasks: (sessionId?: string) => Promise<SubagentTaskSummary[]>
  aiCancelSubagentTask: (subagentId: string) => Promise<boolean>
  aiListAgentDefinitions: (workspaceRoot?: string | null) => Promise<AgentDefinitionSummary[]>
  aiPermissionResponse: (
    sessionId: string,
    requestId: string,
    decision: PermissionDecision
  ) => Promise<boolean>
  aiUserQuestionResponse: (
    sessionId: string,
    requestId: string,
    response: UserQuestionResponse
  ) => Promise<boolean>
  aiFileChangeResponse: (
    sessionId: string,
    changeId: string,
    decision: FileChangeDecision
  ) => Promise<boolean>
  readBrowserPreview: (id: string) => Promise<{ mime: string; data: string } | null>
  onBrowserOpenUrl: (cb: (url: string) => void) => () => void
  editorUpdateDirtyPaths: (paths: string[]) => Promise<boolean>
  aiRevertCheckpoint: (sessionId?: string) => Promise<{ ok: boolean; reverted: number }>
  aiRevertFileChange: (sessionId: string, changeId: string) => Promise<{ ok: boolean; reason?: string }>
  aiRedoFileChange: (sessionId: string, changeId: string) => Promise<{ ok: boolean; reason?: string }>
  onAiEvent: (cb: (event: AgentEvent) => void) => () => void

  
  aiListProfiles: () => Promise<ProviderProfileSummary[]>
  aiGetActiveProfile: () => Promise<ProviderProfileSummary | null>
  aiSetActiveProfile: (id: string | null) => Promise<AgentOpResult>
  aiSaveProfile: (draft: ProfileDraft) => Promise<SaveProfileResult>
  aiDeleteProfile: (id: string) => Promise<AgentOpResult>
  aiTestConnection: (draft: ProfileDraft) => Promise<TestConnectionResult>
  aiTestImageGeneration: (draft: ProfileDraft) => Promise<TestImageGenResult>
  aiFimComplete: (req: FimRequest) => Promise<FimResult>
  aiInlineEdit: (req: InlineEditRequest) => Promise<InlineEditResult>
  aiInlineEditCancel: () => Promise<boolean>
  aiGetAgentSettings: () => Promise<import('@shared/agentSettings').AgentBehaviorSettings>
  aiSaveAgentSettings: (
    patch: Partial<import('@shared/agentSettings').AgentBehaviorSettings>
  ) => Promise<import('@shared/agentSettings').AgentBehaviorSettings>
  aiReadAudit: (limit?: number) => Promise<AuditEntry[]>
  aiReadDebugEvents: (limit?: number) => Promise<DebugEventRecord[]>
  aiGetNetworkSettings: () => Promise<import('@shared/agentSettings').NetworkSettings>
  aiSaveNetworkSettings: (
    patch: Partial<import('@shared/agentSettings').NetworkSettings>
  ) => Promise<import('@shared/agentSettings').NetworkSettings>
  aiGetWebSearchSettings: () => Promise<import('@shared/agentSettings').WebSearchSettingsSummary>
  aiSaveWebSearchSettings: (
    draft: import('@shared/agentSettings').WebSearchSettingsDraft
  ) => Promise<import('@shared/agentSettings').WebSearchSettingsSummary>
  aiGetImageGenSettings: () => Promise<import('@shared/agentSettings').ImageGenSettingsSummary>
  aiSaveImageGenSettings: (
    draft: import('@shared/agentSettings').ImageGenSettingsDraft
  ) => Promise<import('@shared/agentSettings').ImageGenSettingsSummary>
  aiTestImageGen: () => Promise<import('@shared/agentSettings').ImageGenTestResult>
  aiGetMemorySettings: () => Promise<import('@shared/memoryTypes').MemorySettings>
  aiSaveMemorySettings: (
    patch: Partial<import('@shared/memoryTypes').MemorySettings>
  ) => Promise<import('@shared/memoryTypes').MemorySettings>
  aiEnsureProjectMemory: (
    workspaceRoot: string | null
  ) => Promise<{ ok: boolean; path?: string }>
  aiReadProjectMemory: (
    workspaceRoot: string | null
  ) => Promise<{ ok: boolean; path?: string; content?: string }>
  aiWriteProjectMemory: (
    workspaceRoot: string | null,
    content: string
  ) => Promise<{ ok: boolean; reason?: string }>

  
  secretsIsAvailable: () => Promise<boolean>
  secretsSet: (key: string, value: string) => Promise<{ ok: boolean; error?: string }>
  secretsHas: (key: string) => Promise<boolean>

  
  mcp: {
    getSettings: () => Promise<import('@shared/mcpTypes').McpSettings>
    listStatus: (
      workspaceRoot?: string | null
    ) => Promise<import('@shared/mcpTypes').McpServerDetail[]>
    saveServer: (
      draft: import('@shared/mcpTypes').McpServerDraft
    ) => Promise<{ ok: boolean; error?: string }>
    deleteServer: (name: string) => Promise<{ ok: boolean; error?: string }>
    setEnabled: (name: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>
    restart: () => Promise<{ ok: boolean; error?: string }>
    setProjectApproval: (
      name: string,
      state: 'approved' | 'rejected'
    ) => Promise<{ ok: boolean; error?: string }>
    testConnection: (
      config: import('@shared/mcpTypes').McpServerConfig
    ) => Promise<{
      ok: boolean
      error?: string
      toolCount?: number
      serverInfo?: { name: string; version: string }
    }>
    onStatus: (
      cb: (details: import('@shared/mcpTypes').McpServerDetail[]) => void
    ) => () => void
  }

  
  skills: {
    list: (
      workspaceRoot?: string | null
    ) => Promise<import('@shared/skillTypes').SkillDetail[]>
    setEnabled: (
      name: string,
      enabled: boolean
    ) => Promise<import('@shared/skillTypes').SkillOpResult>
    remove: (
      name: string,
      dir: string
    ) => Promise<import('@shared/skillTypes').SkillOpResult>
    install: (
      source: string,
      listOnly?: boolean
    ) => Promise<import('@shared/skillTypes').SkillInstallResult>
  }

  plugins: {
    install: (
      source: string,
      workspaceRoot?: string | null,
      installId?: string
    ) => Promise<import('@shared/pluginTypes').PluginInstallResult>
    onInstallProgress: (
      cb: (p: import('@shared/pluginTypes').PluginInstallProgress) => void
    ) => () => void
    list: () => Promise<import('@shared/pluginTypes').InstalledPluginInfo[]>
    uninstall: (
      pluginName: string,
      workspaceRoot?: string | null
    ) => Promise<import('@shared/pluginTypes').PluginUninstallResult>
  }

  
  lsp: {
    tsdkPath: () => Promise<string | null>
    start: (serverId: LspServerId, workspaceRoot?: string) => Promise<LspStartResult>
    stop: (serverId: LspServerId) => Promise<boolean>
    send: (serverId: LspServerId, message: unknown) => void
    onMessage: (cb: (payload: { serverId: LspServerId; message: unknown }) => void) => () => void
    onClosed: (cb: (payload: { serverId: LspServerId }) => void) => () => void
  }

  
  getPlatform: () => NodeJS.Platform
  getAppVersion: () => Promise<string>

  
  onCloseRequest: (cb: () => void) => () => void
  confirmClose: () => void

  
  onMenuCommand: (cb: (id: string) => void) => () => void

  
  usesCustomTitleBar: boolean
  windowMinimize: () => void
  windowMaximize: () => void
  windowClose: () => void
  windowIsMaximized: () => Promise<boolean>
  onWindowMaximized: (cb: (maximized: boolean) => void) => () => void

  appQuit: () => void
  appReload: () => void
  appZoomIn: () => Promise<void>
  appZoomOut: () => Promise<void>
  appResetZoom: () => Promise<void>
  appToggleFullscreen: () => Promise<void>
}

declare global {
  interface Window {
    lc: LcApi
  }
}
