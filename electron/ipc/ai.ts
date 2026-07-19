import { ipcMain, BrowserWindow, type WebContents } from 'electron'
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
  InlineEditResult,
  UsageStatsQuery,
  UsageStatsResult
} from '@shared/agentTypes'
import { loadProjectRules, ruleActivation } from '../agent/context/rules'
import type { AgentBehaviorSettings } from '@shared/agentSettings'
import {
  getAgentBehaviorSettings,
  saveAgentBehaviorSettings,
  getPermissionMode,
  setPermissionMode,
  getNetworkSettings,
  saveNetworkSettings,
  getWebSearchSettings,
  saveWebSearchSettings,
  getMemorySettings,
  saveMemorySettings,
  getImageGenSettings,
  saveImageGenSettings,
  getVideoGenSettings,
  saveVideoGenSettings,
  getAudioGenSettings,
  saveAudioGenSettings
} from '../agent/settings/agentSettingsStore'
import { resetOutboundDispatcher } from '../agent/providers/network'
import type { NetworkSettings, WebSearchSettingsDraft, WebSearchSettingsSummary, ImageGenSettingsDraft, ImageGenSettingsSummary, ImageGenTestResult, VideoGenSettingsDraft, VideoGenSettingsSummary, VideoTask, AudioGenSettingsDraft, AudioGenSettingsSummary, AudioGenTestResult } from '@shared/agentSettings'
import type { MemorySettings } from '@shared/memoryTypes'
import {
  WEB_SEARCH_IQS_KEY_REF,
  WEB_SEARCH_BRAVE_KEY_REF,
  resolveWebSearchProvider
} from '../agent/tools/webSearchTool'
import { IMAGE_GEN_KEY_REF, generateImages } from '../agent/services/imageGenService'
import { VIDEO_GEN_KEY_REF } from '../agent/services/videoGenService'
import { AUDIO_GEN_KEY_REF, generateSpeech } from '../agent/services/audioGenService'
import { listVideoTasks, cancelVideoTask, deleteVideoTask, clearFinishedVideoTasks, deleteVideoTasksForSession, refreshVideoTasksNow } from '../services/videoTaskQueue'
import { setSecret, hasSecret, deleteSecret } from './secrets'
import {
  listProfiles,
  getActiveProfileSummary,
  setActiveProfile,
  saveProfile,
  deleteProfile,
  onProfilesChanged
} from '../agent/providers/profileStore'
import { testConnection, testImageGeneration } from '../agent/providers/testConnection'
import { fimComplete } from '../agent/providers/fim'
import { inlineEdit } from '../agent/orchestrator/inlineEdit'
import { getExistingQueryEngine, getQueryEngine, disposeQueryEngine } from '../agent/orchestrator/queryEngine'
import { feedTakeoverEvent, exitTakeover, isTakeoverActive } from '../services/takeover/takeoverController'
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
import { queryUsageStats } from '../agent/orchestrator/usageLogStore'
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
  // Provider 配置变更（含 Agent 工具 ModelConfig 在后台切换激活模型）时，
  // 广播给所有渲染窗口，让输入框模型下拉等 UI 实时刷新，而非仅设置面板能看到。
  onProfilesChanged(() => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('ai:profilesChanged')
    }
  })

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
          // 接管激活时，把事件镜像给 HUD 悬浮窗显示进度。
          feedTakeoverEvent(sessionId, ev)
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
      } finally {
        // 安全网：轮次结束时若 agent 忘了调用 ExitDesktopTakeover，自动退出接管，
        // 避免覆盖层与托盘状态卡死。正常路径下 agent 已显式退出，这里是幂等空操作。
        if (isTakeoverActive()) {
          await exitTakeover('completed', { cancelAgent: false })
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

  ipcMain.handle(
    'ai:compactNow',
    async (
      _e,
      payload?: { sessionId?: string; profileId?: string | null; workspaceRoot?: string | null; activeFilePath?: string }
    ): Promise<{ compacted: boolean; preTokens?: number; reason?: string }> => {
      const id = payload?.sessionId || 'default'
      return getQueryEngine(id).compactNow({
        sessionId: id,
        profileId: payload?.profileId,
        workspaceRoot: payload?.workspaceRoot,
        activeFilePath: payload?.activeFilePath
      })
    }
  )

  ipcMain.handle('ai:deleteSession', async (_e, sessionId: string): Promise<boolean> => {
    if (sessionId) {
      await disposeQueryEngine(sessionId)
      setSubagentEventSink(sessionId, null)
      clearSessionBackgroundTools(sessionId)
      deleteSessionFile(sessionId)
      // 连带清理该会话发起的视频任务（停轮询+删除），避免删对话后留下无法从 UI 清理的孤儿任务。
      deleteVideoTasksForSession(sessionId)
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
      const engineFileChanges = engine?.exportFileChanges() ?? []
      saveSession({
        ...session,
        tasks: listTasks(session.id),
        replacementRecords: engineRecords.length > 0 ? engineRecords : session.replacementRecords,
        discoveredDeferredTools: engine?.exportDiscoveredDeferredTools() ?? session.discoveredDeferredTools,
        fileChanges: engineFileChanges.length > 0 ? engineFileChanges : session.fileChanges
      })
    }
    return true
  })

  
  ipcMain.handle(
    'ai:loadSession',
    async (_e, sessionId: string): Promise<PersistedSession | null> => {
      const session = loadSession(sessionId)
      if (session) {
        const engine = getQueryEngine(sessionId)
        engine.restoreHistory(
          session.history.map((m) => ({ role: m.role, content: m.content })),
          session.replacementRecords,
          session.discoveredDeferredTools
        )
        engine.restoreFileChanges(session.fileChanges)
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
    'ai:getUsageStats',
    async (_e, query: UsageStatsQuery): Promise<UsageStatsResult> => {
      const result = queryUsageStats(query ?? {})
      const profiles = listProfiles()
      const nameById = new Map(profiles.map((p) => [p.id, p.name]))
      for (const row of result.perProfile) {
        const name = nameById.get(row.profileId)
        if (name) row.name = name
      }
      return result
    }
  )

  ipcMain.handle(
    'ai:testConnection',
    async (_e, draft: ProfileDraft): Promise<TestConnectionResult> => testConnection(draft)
  )

  ipcMain.handle(
    'ai:testImageGeneration',
    async (_e, draft: ProfileDraft) => testImageGeneration(draft)
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

  // 自动审批开关镜像：渲染端切换/启动时同步到主进程，供微信通道读取。
  ipcMain.handle('ai:getPermissionMode', async (): Promise<'default' | 'acceptEdits'> =>
    getPermissionMode()
  )
  ipcMain.handle(
    'ai:setPermissionMode',
    async (_e, mode: 'default' | 'acceptEdits'): Promise<void> => setPermissionMode(mode)
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

  const imageGenSummary = (): ImageGenSettingsSummary => {
    const settings = getImageGenSettings()
    return { ...settings, hasApiKey: hasSecret(IMAGE_GEN_KEY_REF) }
  }

  ipcMain.handle('ai:getImageGenSettings', async (): Promise<ImageGenSettingsSummary> => imageGenSummary())

  ipcMain.handle(
    'ai:saveImageGenSettings',
    async (_e, draft: ImageGenSettingsDraft): Promise<ImageGenSettingsSummary> => {
      const { apiKey, ...config } = draft ?? {}
      if (apiKey !== undefined) {
        if (apiKey === '') deleteSecret(IMAGE_GEN_KEY_REF)
        else setSecret(IMAGE_GEN_KEY_REF, apiKey)
      }
      saveImageGenSettings(config)
      return imageGenSummary()
    }
  )

  ipcMain.handle('ai:testImageGen', async (): Promise<ImageGenTestResult> => {
    const started = Date.now()
    const outcome = await generateImages(
      { prompt: '生成一张简单的测试图片：一个蓝色的圆形，纯色背景。' },
      { persist: false }
    )
    if (!outcome.ok || !outcome.firstDataUrl) {
      return { ok: false, error: outcome.error ?? '图像生成失败', latencyMs: Date.now() - started }
    }
    return { ok: true, latencyMs: Date.now() - started, dataUrl: outcome.firstDataUrl }
  })

  const videoGenSummary = (): VideoGenSettingsSummary => {
    const settings = getVideoGenSettings()
    return { ...settings, hasApiKey: hasSecret(VIDEO_GEN_KEY_REF) }
  }

  ipcMain.handle('ai:getVideoGenSettings', async (): Promise<VideoGenSettingsSummary> => videoGenSummary())

  ipcMain.handle(
    'ai:saveVideoGenSettings',
    async (_e, draft: VideoGenSettingsDraft): Promise<VideoGenSettingsSummary> => {
      const { apiKey, ...config } = draft ?? {}
      if (apiKey !== undefined) {
        if (apiKey === '') deleteSecret(VIDEO_GEN_KEY_REF)
        else setSecret(VIDEO_GEN_KEY_REF, apiKey)
      }
      saveVideoGenSettings(config)
      return videoGenSummary()
    }
  )

  ipcMain.handle('ai:listVideoTasks', async (): Promise<VideoTask[]> => listVideoTasks())
  ipcMain.handle('ai:refreshVideoTasks', async (_e, sessionId?: string): Promise<VideoTask[]> => refreshVideoTasksNow(sessionId))
  ipcMain.handle('ai:cancelVideoTask', async (_e, id: string): Promise<VideoTask | null> => cancelVideoTask(id))
  ipcMain.handle('ai:deleteVideoTask', async (_e, id: string): Promise<void> => deleteVideoTask(id))
  ipcMain.handle('ai:clearFinishedVideoTasks', async (_e, sessionId?: string): Promise<void> => clearFinishedVideoTasks(sessionId))
  ipcMain.handle('ai:deleteVideoTasksForSession', async (_e, sessionId: string): Promise<void> => deleteVideoTasksForSession(sessionId))

  const audioGenSummary = (): AudioGenSettingsSummary => {
    const settings = getAudioGenSettings()
    return { ...settings, hasApiKey: hasSecret(AUDIO_GEN_KEY_REF) }
  }

  ipcMain.handle('ai:getAudioGenSettings', async (): Promise<AudioGenSettingsSummary> => audioGenSummary())

  ipcMain.handle(
    'ai:saveAudioGenSettings',
    async (_e, draft: AudioGenSettingsDraft): Promise<AudioGenSettingsSummary> => {
      const { apiKey, ...config } = draft ?? {}
      if (apiKey !== undefined) {
        if (apiKey === '') deleteSecret(AUDIO_GEN_KEY_REF)
        else setSecret(AUDIO_GEN_KEY_REF, apiKey)
      }
      saveAudioGenSettings(config)
      return audioGenSummary()
    }
  )

  ipcMain.handle('ai:testAudioGen', async (): Promise<AudioGenTestResult> => {
    const started = Date.now()
    const outcome = await generateSpeech(
      { text: '你好，这是一段文生音测试。' },
      { persist: false }
    )
    if (!outcome.ok || !outcome.firstDataUrl) {
      return { ok: false, error: outcome.error ?? '语音合成失败', latencyMs: Date.now() - started }
    }
    return { ok: true, latencyMs: Date.now() - started, dataUrl: outcome.firstDataUrl }
  })

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

  // 历史回填：把已有历史会话档案逐个反思提取，沉淀进情景记忆库（幂等 + 单飞）。
  // 支持进度推送（边处理边广播 ai:backfillProgress），默认处理全部未完成会话。
  ipcMain.handle(
    'ai:backfillMemory',
    async (_e, opts?: { maxSessions?: number }) => {
      const { backfillMemoryFromHistory } = await import('../agent/memory/backfill')
      return backfillMemoryFromHistory({
        maxSessions: opts?.maxSessions ?? 0, // 0 = 处理全部
        onProgress: (p) => {
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) win.webContents.send('ai:backfillProgress', p)
          }
        }
      })
    }
  )

  // 记忆库可视化：返回（可按工作区筛选的）记忆条目 + 联想边，供设置面板列表/图谱展示。
  ipcMain.handle(
    'ai:listMemoryGraph',
    async (_e, workspaceRoot?: string | null, limit?: number) => {
      const { listMemoryGraph } = await import('../agent/memory/episodicStore')
      const { resolveProjectId } = await import('../agent/memory/paths')
      const projectId = workspaceRoot ? resolveProjectId(workspaceRoot) : null
      return listMemoryGraph({ projectId, limit })
    }
  )

  // 删除一条记忆（含向量/联想边清理）。
  ipcMain.handle('ai:deleteMemory', async (_e, id: unknown) => {
    if (typeof id !== 'string' || !id) return { ok: false }
    const { deleteEpisode } = await import('../agent/memory/episodicStore')
    return deleteEpisode(id)
  })

  // 编辑一条记忆的正文/摘要/类型/显著度；若正文变化则按新内容重建检索向量。
  ipcMain.handle(
    'ai:updateMemory',
    async (
      _e,
      params: { id: string; content?: string; summary?: string | null; kind?: string; salience?: number }
    ) => {
      if (!params || typeof params.id !== 'string' || !params.id) return { ok: false }
      const { updateEpisode, updateEpisodeVector } = await import('../agent/memory/episodicStore')
      const res = updateEpisode(params)
      if (!res.ok) return res
      // 正文变化 → re-embed，保证 auto-recall 的语义检索与最新正文一致。
      if (typeof params.content === 'string' && params.content.trim()) {
        try {
          const { embedOne } = await import('../services/knowledge/embedService')
          const vec = await embedOne(params.content)
          if (vec && vec.length > 0) updateEpisodeVector(params.id, vec)
        } catch {
          // re-embed 失败不影响正文更新，旧向量保留。
        }
      }
      return res
    }
  )

  ipcMain.handle('browser:readPreview', async (_e, id: unknown) => {
    if (typeof id !== 'string' || !id) return null
    const preview = await readBrowserPreview(id)
    if (!preview) return null
    return { mime: preview.mime, data: preview.data.toString('base64') }
  })
}
