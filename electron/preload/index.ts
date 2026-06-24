import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import type {
  AgentEvent,
  AiSendPayload,
  FileChangeDecision,
  PermissionDecision,
  UserQuestionResponse,
  PersistedSession,
  ProfileDraft,
  SubagentTaskSummary,
  AgentDefinitionSummary,
  AgentTask
} from '@shared/agentTypes'
import type { AgentBehaviorSettings } from '@shared/agentSettings'

type LspServerId = 'python' | 'typescript' | 'css' | 'html' | 'json' | 'yaml' | 'vue'


ipcRenderer.setMaxListeners(200)

const api = {
  
  tree: (rootPath: string, expanded: string[], showIgnored?: boolean) =>
    ipcRenderer.invoke('fs:tree', rootPath, expanded, showIgnored),
  readFile: (filePath: string) => ipcRenderer.invoke('fs:readFile', filePath),
  readFileSafe: (filePath: string) => ipcRenderer.invoke('fs:readFileSafe', filePath),
  exists: (filePath: string) => ipcRenderer.invoke('fs:exists', filePath) as Promise<boolean>,
  rootFileNames: (dirPath: string) =>
    ipcRenderer.invoke('fs:rootFileNames', dirPath) as Promise<string[]>,
  listFiles: (rootPath: string) => ipcRenderer.invoke('fs:listFiles', rootPath),
  writeFile: (filePath: string, content: string, encoding?: string) =>
    ipcRenderer.invoke('fs:writeFile', filePath, content, encoding),
  createFile: (parentPath: string, name: string) =>
    ipcRenderer.invoke('fs:createFile', parentPath, name),
  createFolder: (parentPath: string, name: string) =>
    ipcRenderer.invoke('fs:createFolder', parentPath, name),
  deleteItem: (targetPath: string) => ipcRenderer.invoke('fs:delete', targetPath),
  renameItem: (oldPath: string, newName: string) =>
    ipcRenderer.invoke('fs:rename', oldPath, newName),
  moveItem: (src: string, destDir: string) => ipcRenderer.invoke('fs:move', src, destDir),
  copyItem: (src: string, destDir: string) => ipcRenderer.invoke('fs:copy', src, destDir),
  revealItem: (targetPath: string) => ipcRenderer.invoke('fs:reveal', targetPath),
  openExternal: (target: string) => ipcRenderer.invoke('fs:openExternal', target),

  
  watch: (root: string) => ipcRenderer.invoke('fs:watch', root),
  unwatch: () => ipcRenderer.invoke('fs:unwatch'),
  onFsEvent: (cb: (payload: { paths: string[] }) => void) => {
    const listener = (_e: IpcRendererEvent, payload: { paths: string[] }) => cb(payload)
    ipcRenderer.on('fs:event', listener)
    return () => ipcRenderer.removeListener('fs:event', listener)
  },
  
  onAgentWrote: (cb: (payload: { path: string }) => void) => {
    const listener = (_e: IpcRendererEvent, payload: { path: string }) => cb(payload)
    ipcRenderer.on('fs:agentWrote', listener)
    return () => ipcRenderer.removeListener('fs:agentWrote', listener)
  },

  
  searchInFiles: (root: string, query: string, opts: unknown) =>
    ipcRenderer.invoke('search:inFiles', root, query, opts),
  searchReplace: (paths: string[], query: string, replacement: string, opts: unknown) =>
    ipcRenderer.invoke('search:replace', paths, query, replacement, opts),

  
  semantic: {
    build: (root: string) =>
      ipcRenderer.invoke('semantic:build', root) as Promise<{ ok: boolean; error?: string }>,
    cancel: () => ipcRenderer.invoke('semantic:cancel') as Promise<boolean>,
    update: (root: string, paths: string[]) =>
      ipcRenderer.invoke('semantic:update', root, paths) as Promise<boolean>,
    status: (root: string) => ipcRenderer.invoke('semantic:status', root),
    count: (root: string) => ipcRenderer.invoke('semantic:count', root),
    clear: (root: string) => ipcRenderer.invoke('semantic:clear', root) as Promise<boolean>,
    onProgress: (cb: (p: unknown) => void) => {
      const listener = (_e: IpcRendererEvent, p: unknown) => cb(p)
      ipcRenderer.on('semantic:progress', listener)
      return () => ipcRenderer.removeListener('semantic:progress', listener)
    }
  },

  knowledge: {
    probe: () => ipcRenderer.invoke('knowledge:probe') as Promise<{ ok: boolean; error?: string }>,
    listKbs: () => ipcRenderer.invoke('knowledge:listKbs'),
    createKb: (name: string) => ipcRenderer.invoke('knowledge:createKb', name),
    deleteKb: (kbId: string) => ipcRenderer.invoke('knowledge:deleteKb', kbId),
    listDocs: (kbId: string) => ipcRenderer.invoke('knowledge:listDocs', kbId),
    removeDoc: (docId: string) => ipcRenderer.invoke('knowledge:removeDoc', docId),
    pickDocs: () => ipcRenderer.invoke('knowledge:pickDocs') as Promise<string[] | null>,
    pickFolder: () => ipcRenderer.invoke('knowledge:pickFolder') as Promise<string | null>,
    import: (kbId: string, paths: string[]) => ipcRenderer.invoke('knowledge:import', kbId, paths),
    preview: (kbId: string, paths: string[]) => ipcRenderer.invoke('knowledge:preview', kbId, paths),
    cancel: () => ipcRenderer.invoke('knowledge:cancel') as Promise<boolean>,
    status: () => ipcRenderer.invoke('knowledge:status'),
    rebuild: (kbId: string) => ipcRenderer.invoke('knowledge:rebuild', kbId),
    query: (kbId: string, query: string, topK?: number) =>
      ipcRenderer.invoke('knowledge:query', kbId, query, topK),
    healthCheck: (kbId: string) => ipcRenderer.invoke('knowledge:healthCheck', kbId),
    repair: (kbId: string) => ipcRenderer.invoke('knowledge:repair', kbId),
    export: (kbId: string) => ipcRenderer.invoke('knowledge:export', kbId),
    findOutdated: (kbId: string) => ipcRenderer.invoke('knowledge:findOutdated', kbId),
    importFromExport: (kbId: string) => ipcRenderer.invoke('knowledge:importFromExport', kbId),
    onProgress: (cb: (p: unknown) => void) => {
      const listener = (_e: IpcRendererEvent, p: unknown) => cb(p)
      ipcRenderer.on('knowledge:progress', listener)
      return () => ipcRenderer.removeListener('knowledge:progress', listener)
    }
  },


  git: {
    status: (cwd: string) => ipcRenderer.invoke('git:status', cwd),
    diff: (cwd: string, path: string, staged: boolean) =>
      ipcRenderer.invoke('git:diff', cwd, path, staged),
    stage: (cwd: string, paths: string[]) => ipcRenderer.invoke('git:stage', cwd, paths),
    unstage: (cwd: string, paths: string[]) => ipcRenderer.invoke('git:unstage', cwd, paths),
    stageAll: (cwd: string) => ipcRenderer.invoke('git:stageAll', cwd),
    unstageAll: (cwd: string) => ipcRenderer.invoke('git:unstageAll', cwd),
    discard: (cwd: string, change: { path: string; status: string }) =>
      ipcRenderer.invoke('git:discard', cwd, change),
    commit: (cwd: string, message: string, amend: boolean) =>
      ipcRenderer.invoke('git:commit', cwd, message, amend),
    listBranches: (cwd: string) => ipcRenderer.invoke('git:listBranches', cwd),
    checkoutBranch: (cwd: string, name: string, create: boolean) =>
      ipcRenderer.invoke('git:checkoutBranch', cwd, name, create),
    push: (cwd: string) => ipcRenderer.invoke('git:push', cwd),
    pull: (cwd: string) => ipcRenderer.invoke('git:pull', cwd),
    generateMessage: (cwd: string) => ipcRenderer.invoke('git:generateMessage', cwd)
  },

  
  python: {
    discover: (workspaceRoot?: string) => ipcRenderer.invoke('python:discover', workspaceRoot),
    getSelected: (workspaceRoot?: string) =>
      ipcRenderer.invoke('python:getSelected', workspaceRoot),
    setSelected: (workspaceRoot: string | undefined, executable: string) =>
      ipcRenderer.invoke('python:setSelected', workspaceRoot, executable),
    browse: () => ipcRenderer.invoke('python:browse')
  },

  env: {
    check: () =>
      ipcRenderer.invoke('env:check') as Promise<import('@shared/envCheckTypes').EnvCheckResult>
  },

  
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  saveFileAs: (suggestedName: string, content: string) =>
    ipcRenderer.invoke('dialog:saveFile', suggestedName, content),
  clipboardWriteText: (text: string) => ipcRenderer.invoke('clipboard:writeText', text),
  clipboardReadText: () => ipcRenderer.invoke('clipboard:readText') as Promise<string>,

  
  terminalCreate: (cwd: string, cols?: number, rows?: number) =>
    ipcRenderer.invoke('terminal:create', cwd, cols, rows),
  terminalWrite: (id: string, data: string) => ipcRenderer.invoke('terminal:write', id, data),
  terminalResize: (id: string, cols: number, rows: number) =>
    ipcRenderer.invoke('terminal:resize', id, cols, rows),
  terminalAttach: (id: string) => ipcRenderer.invoke('terminal:attach', id),
  terminalKill: (id: string) => ipcRenderer.invoke('terminal:kill', id),
  onTerminalData: (cb: (payload: { id: string; data: string }) => void) => {
    const listener = (_e: IpcRendererEvent, payload: { id: string; data: string }) => cb(payload)
    ipcRenderer.on('terminal:data', listener)
    return () => ipcRenderer.removeListener('terminal:data', listener)
  },
  onTerminalExit: (cb: (payload: { id: string }) => void) => {
    const listener = (_e: IpcRendererEvent, payload: { id: string }) => cb(payload)
    ipcRenderer.on('terminal:exit', listener)
    return () => ipcRenderer.removeListener('terminal:exit', listener)
  },

  
  aiSend: (payload: AiSendPayload) => ipcRenderer.invoke('ai:send', payload),
  aiStop: (sessionId?: string) => ipcRenderer.invoke('ai:stop', sessionId),
  aiClearHistory: (sessionId?: string) => ipcRenderer.invoke('ai:clearHistory', sessionId),
  aiDeleteSession: (sessionId: string) => ipcRenderer.invoke('ai:deleteSession', sessionId),
  aiListSessions: (workspaceId?: string | null) => ipcRenderer.invoke('ai:listSessions', workspaceId),
  aiLoadSession: (sessionId: string) => ipcRenderer.invoke('ai:loadSession', sessionId),
  aiSaveSession: (session: PersistedSession) => ipcRenderer.invoke('ai:saveSession', session),
  aiListRules: (workspaceRoot: string | null) => ipcRenderer.invoke('ai:listRules', workspaceRoot),
  aiListAgentTasks: (sessionId?: string) =>
    ipcRenderer.invoke('ai:listAgentTasks', sessionId) as Promise<AgentTask[]>,
  aiListSubagentTasks: (sessionId?: string) =>
    ipcRenderer.invoke('ai:listSubagentTasks', sessionId) as Promise<SubagentTaskSummary[]>,
  aiCancelSubagentTask: (subagentId: string) =>
    ipcRenderer.invoke('ai:cancelSubagentTask', subagentId) as Promise<boolean>,
  aiListAgentDefinitions: (workspaceRoot?: string | null) =>
    ipcRenderer.invoke('ai:listAgentDefinitions', workspaceRoot) as Promise<AgentDefinitionSummary[]>,
  aiPermissionResponse: (sessionId: string, requestId: string, decision: PermissionDecision) =>
    ipcRenderer.invoke('ai:permissionResponse', sessionId, requestId, decision),
  aiUserQuestionResponse: (sessionId: string, requestId: string, response: UserQuestionResponse) =>
    ipcRenderer.invoke('ai:userQuestionResponse', sessionId, requestId, response),
  aiFileChangeResponse: (sessionId: string, changeId: string, decision: FileChangeDecision) =>
    ipcRenderer.invoke('ai:fileChangeResponse', sessionId, changeId, decision),
  readBrowserPreview: (id: string) =>
    ipcRenderer.invoke('browser:readPreview', id) as Promise<{ mime: string; data: string } | null>,
  onBrowserOpenUrl: (cb: (url: string) => void) => {
    const listener = (_e: IpcRendererEvent, url: string): void => cb(url)
    ipcRenderer.on('browser:openUrl', listener)
    return () => ipcRenderer.removeListener('browser:openUrl', listener)
  },

  // Inline run
  runStart: (command: string, cwd: string) =>
    ipcRenderer.invoke('run:start', command, cwd) as Promise<{ ok: boolean; id?: string; error?: string }>,
  runInput: (id: string, data: string) => ipcRenderer.invoke('run:input', id, data) as Promise<boolean>,
  runStop: (id: string) => ipcRenderer.invoke('run:stop', id) as Promise<boolean>,
  onRunData: (cb: (payload: { id: string; data: string; stream: 'stdout' | 'stderr' }) => void) => {
    const listener = (_e: IpcRendererEvent, payload: { id: string; data: string; stream: 'stdout' | 'stderr' }) => cb(payload)
    ipcRenderer.on('run:data', listener)
    return () => ipcRenderer.removeListener('run:data', listener)
  },
  onRunExit: (cb: (payload: { id: string; exitCode: number | null; signal?: string; error?: string }) => void) => {
    const listener = (_e: IpcRendererEvent, payload: { id: string; exitCode: number | null; signal?: string; error?: string }) => cb(payload)
    ipcRenderer.on('run:exit', listener)
    return () => ipcRenderer.removeListener('run:exit', listener)
  },

  editorUpdateDirtyPaths: (paths: string[]) =>
    ipcRenderer.invoke('editor:updateDirtyPaths', paths),
  aiRevertCheckpoint: (sessionId?: string) =>
    ipcRenderer.invoke('ai:revertCheckpoint', sessionId),
  aiRevertFileChange: (sessionId: string, changeId: string) =>
    ipcRenderer.invoke('ai:revertFileChange', sessionId, changeId) as Promise<{ ok: boolean; reason?: string }>,
  aiRedoFileChange: (sessionId: string, changeId: string) =>
    ipcRenderer.invoke('ai:redoFileChange', sessionId, changeId) as Promise<{ ok: boolean; reason?: string }>,
  onAiEvent: (cb: (event: AgentEvent) => void) => {
    const listener = (_e: IpcRendererEvent, event: AgentEvent) => cb(event)
    ipcRenderer.on('ai:event', listener)
    return () => ipcRenderer.removeListener('ai:event', listener)
  },

  
  aiListProfiles: () => ipcRenderer.invoke('ai:listProfiles'),
  aiGetActiveProfile: () => ipcRenderer.invoke('ai:getActiveProfile'),
  aiSetActiveProfile: (id: string | null) => ipcRenderer.invoke('ai:setActiveProfile', id),
  aiSaveProfile: (draft: ProfileDraft) => ipcRenderer.invoke('ai:saveProfile', draft),
  aiDeleteProfile: (id: string) => ipcRenderer.invoke('ai:deleteProfile', id),
  aiTestConnection: (draft: ProfileDraft) => ipcRenderer.invoke('ai:testConnection', draft),
  aiTestImageGeneration: (draft: ProfileDraft) => ipcRenderer.invoke('ai:testImageGeneration', draft),
  aiFimComplete: (req: import('@shared/agentTypes').FimRequest) =>
    ipcRenderer.invoke('ai:fimComplete', req) as Promise<import('@shared/agentTypes').FimResult>,
  aiInlineEdit: (req: import('@shared/agentTypes').InlineEditRequest) =>
    ipcRenderer.invoke('ai:inlineEdit', req) as Promise<import('@shared/agentTypes').InlineEditResult>,
  aiInlineEditCancel: () => ipcRenderer.invoke('ai:inlineEditCancel') as Promise<boolean>,
  aiGetAgentSettings: () => ipcRenderer.invoke('ai:getAgentSettings'),
  aiSaveAgentSettings: (patch: Partial<AgentBehaviorSettings>) =>
    ipcRenderer.invoke('ai:saveAgentSettings', patch),
  aiReadAudit: (limit?: number) => ipcRenderer.invoke('ai:readAudit', limit),
  aiReadDebugEvents: (limit?: number) => ipcRenderer.invoke('ai:readDebugEvents', limit),
  aiGetNetworkSettings: () => ipcRenderer.invoke('ai:getNetworkSettings'),
  aiSaveNetworkSettings: (patch: Partial<import('@shared/agentSettings').NetworkSettings>) =>
    ipcRenderer.invoke('ai:saveNetworkSettings', patch),
  aiGetWebSearchSettings: () => ipcRenderer.invoke('ai:getWebSearchSettings'),
  aiSaveWebSearchSettings: (draft: import('@shared/agentSettings').WebSearchSettingsDraft) =>
    ipcRenderer.invoke('ai:saveWebSearchSettings', draft),
  aiGetImageGenSettings: () => ipcRenderer.invoke('ai:getImageGenSettings'),
  aiSaveImageGenSettings: (draft: import('@shared/agentSettings').ImageGenSettingsDraft) =>
    ipcRenderer.invoke('ai:saveImageGenSettings', draft),
  aiTestImageGen: () => ipcRenderer.invoke('ai:testImageGen'),
  aiGetVideoGenSettings: () => ipcRenderer.invoke('ai:getVideoGenSettings'),
  aiSaveVideoGenSettings: (draft: import('@shared/agentSettings').VideoGenSettingsDraft) =>
    ipcRenderer.invoke('ai:saveVideoGenSettings', draft),
  aiGetMemorySettings: () => ipcRenderer.invoke('ai:getMemorySettings'),
  aiSaveMemorySettings: (patch: Partial<import('@shared/memoryTypes').MemorySettings>) =>
    ipcRenderer.invoke('ai:saveMemorySettings', patch),
  aiEnsureProjectMemory: (workspaceRoot: string | null) =>
    ipcRenderer.invoke('ai:ensureProjectMemory', workspaceRoot),
  aiReadProjectMemory: (workspaceRoot: string | null) =>
    ipcRenderer.invoke('ai:readProjectMemory', workspaceRoot),
  aiWriteProjectMemory: (workspaceRoot: string | null, content: string) =>
    ipcRenderer.invoke('ai:writeProjectMemory', workspaceRoot, content),

  
  secretsIsAvailable: () => ipcRenderer.invoke('secrets:isAvailable'),
  secretsSet: (key: string, value: string) => ipcRenderer.invoke('secrets:set', key, value),
  secretsHas: (key: string) => ipcRenderer.invoke('secrets:has', key),

  
  mcp: {
    getSettings: () =>
      ipcRenderer.invoke('mcp:getSettings') as Promise<import('@shared/mcpTypes').McpSettings>,
    listStatus: (workspaceRoot?: string | null) =>
      ipcRenderer.invoke('mcp:listStatus', workspaceRoot) as Promise<
        import('@shared/mcpTypes').McpServerDetail[]
      >,
    saveServer: (draft: import('@shared/mcpTypes').McpServerDraft) =>
      ipcRenderer.invoke('mcp:saveServer', draft) as Promise<{ ok: boolean; error?: string }>,
    deleteServer: (name: string) =>
      ipcRenderer.invoke('mcp:deleteServer', name) as Promise<{ ok: boolean; error?: string }>,
    setEnabled: (name: string, enabled: boolean) =>
      ipcRenderer.invoke('mcp:setEnabled', name, enabled) as Promise<{ ok: boolean; error?: string }>,
    restart: () => ipcRenderer.invoke('mcp:restart') as Promise<{ ok: boolean; error?: string }>,
    setProjectApproval: (name: string, state: 'approved' | 'rejected') =>
      ipcRenderer.invoke('mcp:setProjectApproval', name, state) as Promise<{
        ok: boolean
        error?: string
      }>,
    testConnection: (config: import('@shared/mcpTypes').McpServerConfig) =>
      ipcRenderer.invoke('mcp:testConnection', config) as Promise<{
        ok: boolean
        error?: string
        toolCount?: number
        serverInfo?: { name: string; version: string }
      }>,
    onStatus: (cb: (details: import('@shared/mcpTypes').McpServerDetail[]) => void) => {
      const listener = (
        _e: IpcRendererEvent,
        details: import('@shared/mcpTypes').McpServerDetail[]
      ) => cb(details)
      ipcRenderer.on('mcp:status', listener)
      return () => ipcRenderer.removeListener('mcp:status', listener)
    }
  },

  
  skills: {
    list: (workspaceRoot?: string | null) =>
      ipcRenderer.invoke('skills:list', workspaceRoot) as Promise<
        import('@shared/skillTypes').SkillDetail[]
      >,
    setEnabled: (name: string, enabled: boolean) =>
      ipcRenderer.invoke('skills:setEnabled', name, enabled) as Promise<
        import('@shared/skillTypes').SkillOpResult
      >,
    remove: (name: string, dir: string) =>
      ipcRenderer.invoke('skills:delete', name, dir) as Promise<
        import('@shared/skillTypes').SkillOpResult
      >,
    install: (source: string, listOnly?: boolean) =>
      ipcRenderer.invoke('skills:install', source, listOnly) as Promise<
        import('@shared/skillTypes').SkillInstallResult
      >
  },

  plugins: {
    install: (source: string, workspaceRoot?: string | null, installId?: string) =>
      ipcRenderer.invoke('plugins:install', source, workspaceRoot, installId) as Promise<
        import('@shared/pluginTypes').PluginInstallResult
      >,
    onInstallProgress: (cb: (p: import('@shared/pluginTypes').PluginInstallProgress) => void) => {
      const listener = (_e: unknown, p: import('@shared/pluginTypes').PluginInstallProgress): void => cb(p)
      ipcRenderer.on('plugins:installProgress', listener)
      return () => ipcRenderer.removeListener('plugins:installProgress', listener)
    },
    list: () =>
      ipcRenderer.invoke('plugins:list') as Promise<
        import('@shared/pluginTypes').InstalledPluginInfo[]
      >,
    uninstall: (pluginName: string, workspaceRoot?: string | null) =>
      ipcRenderer.invoke('plugins:uninstall', pluginName, workspaceRoot) as Promise<
        import('@shared/pluginTypes').PluginUninstallResult
      >
  },

  
  lsp: {
    tsdkPath: () => ipcRenderer.invoke('lsp:tsdkPath') as Promise<string | null>,
    start: (serverId: LspServerId, workspaceRoot?: string) =>
      ipcRenderer.invoke('lsp:start', serverId, workspaceRoot) as Promise<{
        ok: boolean
        error?: string
      }>,
    stop: (serverId: LspServerId) =>
      ipcRenderer.invoke('lsp:stop', serverId) as Promise<boolean>,
    send: (serverId: LspServerId, message: unknown) =>
      ipcRenderer.send('lsp:send', serverId, message),
    onMessage: (cb: (payload: { serverId: LspServerId; message: unknown }) => void) => {
      const listener = (
        _e: IpcRendererEvent,
        payload: { serverId: LspServerId; message: unknown }
      ) => cb(payload)
      ipcRenderer.on('lsp:message', listener)
      return () => ipcRenderer.removeListener('lsp:message', listener)
    },
    onClosed: (cb: (payload: { serverId: LspServerId }) => void) => {
      const listener = (_e: IpcRendererEvent, payload: { serverId: LspServerId }) =>
        cb(payload)
      ipcRenderer.on('lsp:closed', listener)
      return () => ipcRenderer.removeListener('lsp:closed', listener)
    }
  },

  
  getPlatform: () => process.platform,
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),

  
  
  onCloseRequest: (cb: () => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('app:queryClose', listener)
    return () => ipcRenderer.removeListener('app:queryClose', listener)
  },
  confirmClose: () => ipcRenderer.send('app:confirmClose'),

  
  onMenuCommand: (cb: (id: string) => void) => {
    const listener = (_e: IpcRendererEvent, id: string) => cb(id)
    ipcRenderer.on('menu:command', listener)
    return () => ipcRenderer.removeListener('menu:command', listener)
  },

  
  usesCustomTitleBar: process.platform === 'win32',
  windowMinimize: () => ipcRenderer.send('window:minimize'),
  windowMaximize: () => ipcRenderer.send('window:maximize'),
  windowClose: () => ipcRenderer.send('window:close'),
  windowIsMaximized: () => ipcRenderer.invoke('window:isMaximized') as Promise<boolean>,
  onWindowMaximized: (cb: (maximized: boolean) => void) => {
    const listener = (_e: IpcRendererEvent, maximized: boolean) => cb(maximized)
    ipcRenderer.on('window:maximized', listener)
    return () => ipcRenderer.removeListener('window:maximized', listener)
  },

  
  appQuit: () => ipcRenderer.send('app:quit'),
  appReload: () => ipcRenderer.send('app:reload'),
  appZoomIn: () => ipcRenderer.invoke('app:zoomIn') as Promise<void>,
  appZoomOut: () => ipcRenderer.invoke('app:zoomOut') as Promise<void>,
  appResetZoom: () => ipcRenderer.invoke('app:resetZoom') as Promise<void>,
  appToggleFullscreen: () => ipcRenderer.invoke('app:toggleFullscreen') as Promise<void>
}

contextBridge.exposeInMainWorld('lc', api)



