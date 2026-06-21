import { ipcMain, type WebContents } from 'electron'
import type {
  AiSendPayload,
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
  SubagentTaskSummary,
  AgentDefinitionSummary,
  AgentTask,
  FimRequest,
  FimResult,
  InlineEditRequest,
  InlineEditResult
} from '@shared/agentTypes'
import { loadProjectRules, ruleActivation } from '../agent/context/rules'
import type { AgentBehaviorSettings } from '@shared/agentSettings'
import {
  getAgentBehaviorSettings,
  saveAgentBehaviorSettings,
  getNetworkSettings,
  saveNetworkSettings,
  getWebSearchSettings,
  saveWebSearchSettings,
  getMemorySettings,
  saveMemorySettings
} from '../agent/settings/agentSettingsStore'
import { resetOutboundDispatcher } from '../agent/providers/network'
import type { NetworkSettings, WebSearchSettingsDraft, WebSearchSettingsSummary } from '@shared/agentSettings'
import type { MemorySettings } from '@shared/memoryTypes'
import {
  WEB_SEARCH_IQS_KEY_REF,
  WEB_SEARCH_BRAVE_KEY_REF,
  resolveWebSearchProvider
} from '../agent/tools/webSearchTool'
import { setSecret, hasSecret, deleteSecret } from './secrets'
import {
  listProfiles,
  getActiveProfileSummary,
  setActiveProfile,
  saveProfile,
  deleteProfile
} from '../agent/providers/profileStore'
import { testConnection } from '../agent/providers/testConnection'
import { fimComplete } from '../agent/providers/fim'
import { inlineEdit } from '../agent/orchestrator/inlineEdit'
import { getExistingQueryEngine, getQueryEngine, disposeQueryEngine } from '../agent/orchestrator/queryEngine'
import {
  cancelSubagentTask,
  listAvailableSubagentDefinitions,
  listSubagentTasks,
  setSubagentEventSink
} from '../agent/orchestrator/subagent'
import { clearSessionBackgroundTools, setBackgroundToolEventSink } from '../agent/orchestrator/backgroundToolExecution'
import { ensureProjectMemory, readProjectMemoryContent, writeProjectMemoryContent } from '../agent/memory/store'
import {
  listSessions,
  loadSession,
  saveSession,
  deleteSessionFile
} from '../agent/orchestrator/sessionPersistence'
import { readRecentAudit, type AuditEntry } from '../agent/orchestrator/audit'
import { readRecentDebugEvents, type DebugEventRecord } from '../agent/orchestrator/debugLog'
import { listTasks, replaceTasks } from '../agent/tasks/taskStore'
import { setActiveAgentWebContents } from '../services/diagnosticsBridge'
import { readBrowserPreview } from '../services/browserPreviewImage'

const sinkSessionsByWebContents = new WeakMap<WebContents, Set<string>>()

function trackEventSinkSession(wc: WebContents, sessionId: string): void {
  let sessions = sinkSessionsByWebContents.get(wc)
  if (!sessions) {
    const tracked = new Set<string>()
    sessions = tracked
    sinkSessionsByWebContents.set(wc, tracked)
    wc.once('destroyed', () => {
      for (const id of tracked) {
        setSubagentEventSink(id, null)
        setBackgroundToolEventSink(id, null)
      }
      tracked.clear()
    })
  }
  sessions.add(sessionId)
}


export function registerAiIpc(): void {
  ipcMain.handle('ai:send', async (e, payload: AiSendPayload): Promise<AgentOpResult> => {
    if (!payload || typeof payload.turnId !== 'string' || typeof payload.message !== 'string') {
      return { ok: false, error: '无效的发送载荷' }
    }
    const wc = e.sender
    const sessionId = payload.sessionId || 'default'
    setActiveAgentWebContents(wc)
    trackEventSinkSession(wc, sessionId)
    setSubagentEventSink(sessionId, (event) => {
      if (!wc.isDestroyed()) wc.send('ai:event', event)
    })
    setBackgroundToolEventSink(sessionId, (event) => {
      if (!wc.isDestroyed()) wc.send('ai:event', event)
    })
    const engine = getQueryEngine(sessionId)
    
    void (async () => {
      try {
        for await (const ev of engine.submitTurn(payload)) {
          if (wc.isDestroyed()) break
          wc.send('ai:event', ev)
        }
      } catch (err) {
        if (!wc.isDestroyed()) {
          wc.send('ai:event', {
            type: 'error',
            turnId: payload.turnId,
            code: 'unknown',
            message: err instanceof Error ? err.message : '未知错误',
            retryable: false
          })
        }
      }
    })()
    return { ok: true }
  })

  ipcMain.handle('ai:stop', async (_e, sessionId?: string): Promise<boolean> => {
    const id = sessionId || 'default'
    getQueryEngine(id).cancel(id)
    setActiveAgentWebContents(null)
    return true
  })

  ipcMain.handle('ai:clearHistory', async (_e, sessionId?: string): Promise<boolean> => {
    const id = sessionId || 'default'
    getQueryEngine(id).clear(id)
    return true
  })

  ipcMain.handle('ai:deleteSession', async (_e, sessionId: string): Promise<boolean> => {
    if (sessionId) {
      await disposeQueryEngine(sessionId)
      setSubagentEventSink(sessionId, null)
      clearSessionBackgroundTools(sessionId)
      deleteSessionFile(sessionId)
    }
    return true
  })

  
  ipcMain.handle('ai:listSessions', async (_e, workspaceId?: string | null): Promise<PersistedSession[]> =>
    listSessions(workspaceId)
  )

  ipcMain.handle('ai:saveSession', async (_e, session: PersistedSession): Promise<boolean> => {
    if (session && typeof session.id === 'string') {
      const engine = getExistingQueryEngine(session.id)
      const engineRecords = engine?.exportContentReplacementRecords() ?? []
      saveSession({
        ...session,
        tasks: listTasks(session.id),
        replacementRecords: engineRecords.length > 0 ? engineRecords : session.replacementRecords,
        discoveredDeferredTools: engine?.exportDiscoveredDeferredTools() ?? session.discoveredDeferredTools
      })
    }
    return true
  })

  
  ipcMain.handle(
    'ai:loadSession',
    async (_e, sessionId: string): Promise<PersistedSession | null> => {
      const session = loadSession(sessionId)
      if (session) {
        getQueryEngine(sessionId).restoreHistory(
          session.history.map((m) => ({ role: m.role, content: m.content })),
          session.replacementRecords,
          session.discoveredDeferredTools
        )
        replaceTasks(sessionId, session.tasks ?? [])
      }
      return session
    }
  )

  ipcMain.handle(
    'ai:permissionResponse',
    async (_e, sessionId: string, requestId: string, decision: PermissionDecision): Promise<boolean> => {
      getQueryEngine(sessionId || 'default').resolvePermission(requestId, decision)
      return true
    }
  )

  ipcMain.handle(
    'ai:userQuestionResponse',
    async (_e, sessionId: string, requestId: string, response: UserQuestionResponse): Promise<boolean> => {
      getQueryEngine(sessionId || 'default').resolveUserQuestion(requestId, response)
      return true
    }
  )

  ipcMain.handle(
    'ai:fileChangeResponse',
    async (_e, sessionId: string, changeId: string, decision: FileChangeDecision): Promise<boolean> => {
      getQueryEngine(sessionId || 'default').resolveFileChange(changeId, decision)
      return true
    }
  )

  ipcMain.handle(
    'ai:revertCheckpoint',
    async (_e, sessionId?: string): Promise<{ ok: boolean; reverted: number }> => {
      const reverted = await getQueryEngine(sessionId || 'default').revertCheckpoint()
      return { ok: true, reverted }
    }
  )

  ipcMain.handle(
    'ai:revertFileChange',
    async (_e, sessionId: string, changeId: string): Promise<{ ok: boolean; reason?: string }> => {
      return getQueryEngine(sessionId || 'default').revertFileChange(changeId)
    }
  )

  ipcMain.handle(
    'ai:redoFileChange',
    async (_e, sessionId: string, changeId: string): Promise<{ ok: boolean; reason?: string }> => {
      return getQueryEngine(sessionId || 'default').redoFileChange(changeId)
    }
  )

  
  ipcMain.handle('ai:listProfiles', async (): Promise<ProviderProfileSummary[]> => listProfiles())

  ipcMain.handle(
    'ai:getActiveProfile',
    async (): Promise<ProviderProfileSummary | null> => getActiveProfileSummary()
  )

  ipcMain.handle(
    'ai:setActiveProfile',
    async (_e, id: string | null): Promise<AgentOpResult> => setActiveProfile(id)
  )

  ipcMain.handle(
    'ai:saveProfile',
    async (_e, draft: ProfileDraft): Promise<SaveProfileResult> => saveProfile(draft)
  )

  ipcMain.handle(
    'ai:deleteProfile',
    async (_e, id: string): Promise<AgentOpResult> => deleteProfile(id)
  )

  ipcMain.handle(
    'ai:testConnection',
    async (_e, draft: ProfileDraft): Promise<TestConnectionResult> => testConnection(draft)
  )

  let fimAbort: AbortController | null = null
  ipcMain.handle('ai:fimComplete', async (_e, req: FimRequest): Promise<FimResult> => {
    
    if (fimAbort) fimAbort.abort()
    const controller = new AbortController()
    fimAbort = controller
    try {
      return await fimComplete(req, controller.signal)
    } finally {
      if (fimAbort === controller) fimAbort = null
    }
  })

  let inlineEditAbort: AbortController | null = null
  ipcMain.handle('ai:inlineEdit', async (_e, req: InlineEditRequest): Promise<InlineEditResult> => {
    
    if (inlineEditAbort) inlineEditAbort.abort()
    const controller = new AbortController()
    inlineEditAbort = controller
    try {
      return await inlineEdit(req, controller.signal)
    } finally {
      if (inlineEditAbort === controller) inlineEditAbort = null
    }
  })

  ipcMain.handle('ai:inlineEditCancel', () => {
    if (inlineEditAbort) {
      inlineEditAbort.abort()
      inlineEditAbort = null
    }
    return true
  })

  
  ipcMain.handle('ai:listRules', async (_e, workspaceRoot: string | null): Promise<RuleSummary[]> => {
    const rules = await loadProjectRules(workspaceRoot)
    return rules.map((r) => ({
      name: r.name,
      description: r.description,
      activation: ruleActivation(r),
      body: r.body
    }))
  })

  ipcMain.handle('ai:listAgentTasks', async (_e, sessionId?: string): Promise<AgentTask[]> =>
    listTasks(sessionId || 'default')
  )

  ipcMain.handle('ai:listSubagentTasks', async (_e, sessionId?: string): Promise<SubagentTaskSummary[]> =>
    listSubagentTasks(sessionId)
  )

  ipcMain.handle('ai:cancelSubagentTask', async (_e, subagentId: string): Promise<boolean> =>
    cancelSubagentTask(subagentId)
  )

  ipcMain.handle(
    'ai:listAgentDefinitions',
    async (_e, workspaceRoot?: string | null): Promise<AgentDefinitionSummary[]> =>
      listAvailableSubagentDefinitions(workspaceRoot)
  )

  ipcMain.handle('ai:getAgentSettings', async (): Promise<AgentBehaviorSettings> =>
    getAgentBehaviorSettings()
  )

  ipcMain.handle(
    'ai:saveAgentSettings',
    async (_e, patch: Partial<AgentBehaviorSettings>): Promise<AgentBehaviorSettings> =>
      saveAgentBehaviorSettings(patch ?? {})
  )

  
  ipcMain.handle('ai:readAudit', async (_e, limit?: number): Promise<AuditEntry[]> =>
    readRecentAudit(typeof limit === 'number' ? limit : 200)
  )

  ipcMain.handle('ai:readDebugEvents', async (_e, limit?: number): Promise<DebugEventRecord[]> =>
    readRecentDebugEvents(typeof limit === 'number' ? limit : 200)
  )

  
  ipcMain.handle('ai:getNetworkSettings', async (): Promise<NetworkSettings> => getNetworkSettings())

  ipcMain.handle(
    'ai:saveNetworkSettings',
    async (_e, patch: Partial<NetworkSettings>): Promise<NetworkSettings> => {
      const next = saveNetworkSettings(patch ?? {})
      resetOutboundDispatcher()
      return next
    }
  )

  
  const webSearchSummary = (): WebSearchSettingsSummary => {
    const settings = getWebSearchSettings()
    const hasIqsKey = hasSecret(WEB_SEARCH_IQS_KEY_REF)
    const hasBraveKey = hasSecret(WEB_SEARCH_BRAVE_KEY_REF)
    return {
      ...settings,
      hasIqsKey,
      hasBraveKey,
      effectiveProvider: resolveWebSearchProvider(settings.provider, { hasIqsKey, hasBraveKey })
    }
  }

  ipcMain.handle('ai:getWebSearchSettings', async (): Promise<WebSearchSettingsSummary> => webSearchSummary())

  ipcMain.handle(
    'ai:saveWebSearchSettings',
    async (_e, draft: WebSearchSettingsDraft): Promise<WebSearchSettingsSummary> => {
      const { iqsApiKey, braveApiKey, ...config } = draft ?? {}
      
      if (iqsApiKey !== undefined) {
        if (iqsApiKey === '') deleteSecret(WEB_SEARCH_IQS_KEY_REF)
        else setSecret(WEB_SEARCH_IQS_KEY_REF, iqsApiKey)
      }
      if (braveApiKey !== undefined) {
        if (braveApiKey === '') deleteSecret(WEB_SEARCH_BRAVE_KEY_REF)
        else setSecret(WEB_SEARCH_BRAVE_KEY_REF, braveApiKey)
      }
      saveWebSearchSettings(config)
      return webSearchSummary()
    }
  )

  ipcMain.handle('ai:getMemorySettings', async (): Promise<MemorySettings> => getMemorySettings())

  ipcMain.handle(
    'ai:saveMemorySettings',
    async (_e, patch: Partial<MemorySettings>): Promise<MemorySettings> => saveMemorySettings(patch ?? {})
  )

  // 确保项目记忆文件存在（不存在则用模板创建），返回其绝对路径供编辑器打开。
  ipcMain.handle(
    'ai:ensureProjectMemory',
    async (_e, workspaceRoot: string | null): Promise<{ ok: boolean; path?: string }> => {
      const path = await ensureProjectMemory(workspaceRoot)
      return path ? { ok: true, path } : { ok: false }
    }
  )

  // 读取项目记忆内容（不存在则用模板创建后返回），供设置面板内联编辑。
  ipcMain.handle(
    'ai:readProjectMemory',
    async (_e, workspaceRoot: string | null): Promise<{ ok: boolean; path?: string; content?: string }> => {
      const path = await ensureProjectMemory(workspaceRoot)
      if (!path) return { ok: false }
      const content = await readProjectMemoryContent(workspaceRoot)
      return { ok: true, path, content: content ?? '' }
    }
  )

  // 覆盖写入项目记忆内容（设置面板内联编辑保存）。
  ipcMain.handle(
    'ai:writeProjectMemory',
    async (_e, workspaceRoot: string | null, content: string): Promise<{ ok: boolean; reason?: string }> => {
      return writeProjectMemoryContent(workspaceRoot, typeof content === 'string' ? content : '')
    }
  )

  ipcMain.handle('browser:readPreview', async (_e, id: unknown) => {
    if (typeof id !== 'string' || !id) return null
    const preview = await readBrowserPreview(id)
    if (!preview) return null
    return { mime: preview.mime, data: preview.data.toString('base64') }
  })
}
