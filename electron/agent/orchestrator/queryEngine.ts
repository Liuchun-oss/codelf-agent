import { randomUUID } from 'crypto'
import type {
  AgentEvent,
  AiSendPayload,
  FileChangeDecision,
  PermissionDecision,
  TokenUsage,
  UserQuestionResponse,
  ContentReplacementRecord,
  PersistedChatMessage,
  PersistedFileChange,
  PersistedSessionInProgressReason
} from '@shared/agentTypes'
import { APP_NAME } from '@shared/appConfig'
import {
  createAdapter,
  ProviderError,
  isTransientNetworkError,
  type ChatMessage,
  type ToolCallRequest,
  type ToolDef
} from '../providers'
import {
  getActiveProfileId,
  getProfileRaw,
  getActiveProfileApiKey
} from '../providers/profileStore'
import { recycleOutboundDispatcher } from '../providers/network'
import { fetchSystemPromptPartsAsync, assembleSystemMessage, fetchDynamicContextBlock, getStaticSystemCore } from '../prompts/assembler'
import { buildKnowledgeContextBlock } from '../prompts/context/knowledgeContext'
import { buildRecallInjection } from '../memory/recall'
import type { PromptContext } from '../prompts/types'
import {
  dirtyConflictReminder,
  permissionDeniedReminder,
  truncatedOutputReminder,
  systemReminder
} from '../prompts/reminders'
import { buildUserMessage } from '../context/packer'
import { countChatMessagesTokens, countTokens } from '../context/tokenCounter'
import {
  applyStreamUsageChunk,
  createRoundUsageAcc,
  computePromptCacheStatus,
  mergeRoundUsageIntoTurn
} from './usageAccum'
import { buildPromptCacheKey, buildPromptCacheOptions } from './promptCache'
import { buildDefaultRegistry, type ToolRegistry } from '../tools/registry'
import { ensureMcpReady, syncMcpToolsIntoRegistry } from '../mcp/sync'
import type { SnipHistoryRequest, Tool, ToolContext, ToolResult } from '../tools/types'
import { ToolCallAccumulator, executeToolBatch, parseToolArguments } from '../tools/streamingExecutor'
import { PermissionEngine } from '../permissions/engine'
import { PermissionBroker } from '../permissions/broker'
import { DenialTracker, denialLimitMessage } from '../permissions/denialTracking'
import { addProjectPermissionAllow } from '../permissions/projectRulesStore'
import { HookRunner, type HookInput } from '../hooks'
import {
  cloneContentReplacementState,
  createContentReplacementState,
  createContentReplacementStateFromRecords,
  exportContentReplacementRecords,
  externalizeToolResultsWithState,
  type ContentReplacementState
} from '../tools/resultStorage'
import { isPathDirty } from '../../services/editorSnapshot'
import { currentShellName } from '../../services/headlessTerminal'
import { FileChangeBroker } from './fileChangeBroker'
import { UserQuestionBroker } from './userQuestionBroker'
import { TurnCheckpoint } from './checkpoint'
import { FileChangeHistory } from './fileChangeHistory'
import { writeTextFile } from '../../services/fsService'
import { noteAgentWrite } from '../../services/localWriteRegistry'
import { getAgentBehaviorSettings, getMemorySettings } from '../settings/agentSettingsStore'
import { buildContextBreakdown } from '../context/contextBreakdown'
import { lookupModelMetadata, isKimiReasoningModel } from '../providers/modelMetadata'
import { maybeCompactTurns, estimateSystemTokens } from './compact'
import { runCheckpointWriter, buildRebuildInjection } from '../memory/writer'
import { detectTaskCompletion, buildNoteReminder, isMemoryWorthyTurn } from './taskCompletionDetector'
import { recordAudit } from './audit'
import { recordDebugEvent } from './debugLog'
import { appendUsageLog } from './usageLogStore'
import { ASK_USER_NAME, askUserSchema } from '../tools/userTools'
import { ASK_USER_QUESTION_NAME, askUserQuestionSchema } from '../tools/askUserQuestionTool'
import { resetTasks } from '../tasks/taskStore'
import { awaitBackgroundTool, cancelSessionBackgroundTools, clearSessionBackgroundTools, startBackgroundTool } from './backgroundToolExecution'
import { closeBrowserSessionsForAgent } from '../../services/browserSession'
import { closeDesktopSessionsForAgent } from '../../services/desktopSession'
import { deleteBrowserPreview } from '../../services/browserPreviewImage'
import { saveGeneratedImage } from '../../services/generatedImageStore'
import { loadSession, saveSession } from './sessionPersistence'
import { EXECUTE_EXTRA_TOOL_NAME } from '../tools/deferredTools'
import { buildDeferredToolsAnnouncement, restoreDeferredToolDiscovery } from '../tools/deferredToolDiscovery'
import { GENERATE_IMAGE_NAME, EDIT_IMAGE_NAME } from '../prompts/tools/imageGen'

const DEFAULT_RESPONSE_LANGUAGE = 'Simplified Chinese'

// 把用户附件图片（data URL）落盘为本地 codelf-artifact:// 路径。
// 返回成功落盘的 artifact URL 列表，供模型作为参考图引用。
async function persistUserImages(images: { dataUrl: string; name?: string }[]): Promise<string[]> {
  const paths: string[] = []
  for (const img of images) {
    const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(img.dataUrl)
    if (!m) continue
    try {
      const saved = await saveGeneratedImage(m[2], m[1])
      paths.push(saved.url)
    } catch { /* 单张落盘失败则跳过 */ }
  }
  return paths
}

// 生成告知模型「附件图片本地路径」的文本块。模型可把这些路径作为参考图
// 传给 GenerateImage（referenceImages）/ GenerateVideo（firstFrame 等）工具。
function buildAttachedImagesNote(paths: string[]): string {
  const list = paths.map((p, i) => `${i + 1}. ${p}`).join('\n')
  return `[附件图片] 用户随消息附带了以下本地图片（已保存）。如果需要把它们作为参考图/首帧用于图像或视频生成等工具，请直接使用下面的路径作为工具入参（如 GenerateImage 的 referenceImages、GenerateVideo 的 firstFrame）：\n${list}`
}

// 「防假完成」启发式：用户是否在请求生成/编辑图片。
// 仅作粗判，用于检测模型是否声称完成却未真正调用图像工具。
function userAskedForImage(text: string): boolean {
  if (!text) return false
  const t = text.toLowerCase()
  // 中文：生成/画/绘制/做一张…图/海报/图标/插画/logo；英文：generate/draw/create … image/picture/poster/icon/logo
  const zh = /(生成|画|绘制|做|制作|设计|来一?张|搞一?张).{0,12}(图|图片|海报|图标|插画|头像|壁纸|封面|logo)/.test(text) ||
    /(图片|海报|插画|图标|壁纸|封面).{0,6}(生成|绘制|画出来)/.test(text)
  const en = /\b(generate|draw|create|make|design|render)\b.{0,20}\b(image|picture|photo|poster|icon|logo|illustration|wallpaper|artwork)\b/.test(t)
  return zh || en
}

// 模型是否在文本里「声称已完成」（却可能没真正出图）。
function claimsImageDone(text: string): boolean {
  if (!text) return false
  const t = text.trim()
  if (t.length === 0) return false
  const zh = /(已|帮你).{0,4}(生成|完成|画好|做好|搞定)|生成好了|已经.{0,4}(生成|完成)|图片.{0,4}(已|生成)/.test(t)
  const en = /\b(here('| i)s|i('| ?ve)?\s*(generated|created|made|drawn)|done|completed|image is ready)\b/i.test(t)
  return zh || en
}

// 「防假完成」（文件编辑）：用户是否在请求修改/编辑/改写文件或代码。仅作粗判。
function userAskedForFileEdit(text: string): boolean {
  if (!text) return false
  const t = text.toLowerCase()
  const zh = /(改写|修改|编辑|重构|调整|更新|替换|优化|重写|新增|添加|实现|修复|删掉|去掉).{0,16}(文件|代码|函数|方法|类|组件|配置|脚本|样式|逻辑|功能|接口|模块)/.test(text)
  const en = /\b(edit|modify|change|rewrite|refactor|update|fix|implement|add|remove|replace)\b.{0,24}\b(file|code|function|method|class|component|config|script|module|feature)\b/.test(t)
  return zh || en
}

// 模型是否在文本里「声称已完成文件编辑/代码修改」（却可能没真正写盘）。
function claimsEditDone(text: string): boolean {
  if (!text) return false
  const t = text.trim()
  if (t.length === 0) return false
  const zh = /(已|帮你|为你).{0,6}(修改|编辑|改写|更新|重构|调整|替换|实现|修复|添加|新增|创建|完成)|修改(好|完)了|改好了|已经.{0,6}(修改|更新|完成|改好)|代码.{0,4}(已|更新|修改)/.test(t)
  const en = /\b(i('| ?ve)?\s*(edited|modified|updated|changed|refactored|implemented|fixed|added|created)|here('| i)s the (updated|modified|fixed)|done|completed|changes are (made|applied))\b/i.test(t)
  return zh || en
}

// 模型是否在文本里「判断该文件本就无需修改」。这是正当结论，不应被当成假完成而强行逼改。
function claimsNoEditNeeded(text: string): boolean {
  if (!text) return false
  const t = text.toLowerCase()
  const zh = /(无需|不需要|无须|没必要|不必|无须要).{0,8}(修改|改动|编辑|调整|变更|更改)|(本身|已经|目前).{0,6}(正确|没问题|无问题|符合|满足|是对的)|(不用|没有).{0,4}(改|动)/.test(text)
  const en = /\b(no|not?)\s+(change|edit|modific\w*|update)s?\s+(needed|necessary|required)|already (correct|fine|valid|in place)|nothing to (change|edit|fix)|no need to (change|edit|modify)\b/i.test(t)
  return zh || en
}

function todayISODate(): string {
  return new Date().toISOString().slice(0, 10)
}

function argsForEvent(raw: string): Record<string, unknown> {
  const parsed = parseToolArguments(raw)
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>
  }
  return { _raw: raw }
}

function permissionSummary(call: ToolCallRequest): string {
  const args = argsForEvent(call.arguments)
  if (
    (call.name === 'run_terminal_cmd' || call.name === 'PowerShell' || call.name === 'StartTerminalTask') &&
    typeof args.command === 'string'
  ) {
    return `执行命令：${args.command}`
  }
  if (call.name === 'WriteTerminalTask' && typeof args.input === 'string') {
    const taskId = typeof args.task_id === 'string' ? args.task_id : ''
    return `向终端任务${taskId ? ` ${taskId}` : ''}输入：${JSON.stringify(args.input)}`
  }
  if (call.name === 'web_fetch' && typeof args.url === 'string') {
    return `抓取网页：${args.url}`
  }
  if (typeof args.path === 'string') return `${call.name}：${args.path}`
  return `调用工具：${call.name}`
}

function permissionDetails(call: ToolCallRequest): { command?: string; path?: string } {
  const args = argsForEvent(call.arguments)
  const details: { command?: string; path?: string } = {}
  if (typeof args.command === 'string') details.command = args.command
  if (typeof args.path === 'string') details.path = args.path
  return details
}

function isContextLengthError(e: unknown): boolean {
  const message = e instanceof Error ? e.message.toLowerCase() : String(e).toLowerCase()
  return /context( window| length)?|prompt too long|maximum context|token limit|too many tokens/.test(message)
}

function pushUnique(list: string[], value: unknown, max = 8): void {
  if (typeof value !== 'string') return
  const trimmed = value.trim()
  if (!trimmed || list.includes(trimmed)) return
  list.push(trimmed)
  if (list.length > max) list.splice(0, list.length - max)
}

function extractPathLikeValues(value: unknown, out: string[]): void {
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (typeof child === 'string' && /path|file|target/i.test(key)) {
      pushUnique(out, child)
    } else if (child && typeof child === 'object') {
      extractPathLikeValues(child, out)
    }
  }
}

// 主动剥离所有消息中的图片：当前模型不支持视觉时，把历史里残留的图片块（可能是
// 上一轮换用支持图片的模型时存入的）全部去掉，避免整段历史因带 image_url 而被 400
// 拒绝。不依赖错误字符串匹配（中转站的 400 文案千差万别），从源头保证外发消息干净。
function stripImagesForNonVision(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (!m.images?.length) return m
    const note = `（图片已省略：当前模型不支持图片输入，共 ${m.images.length} 张）`
    const content = m.content ? `${m.content}\n${note}` : note
    const { images: _drop, ...rest } = m
    return { ...rest, content }
  })
}

function buildCompactRestoreHints(params: {
  historyTurns: HistoryTurn[]
  activeFilePath?: string
  workspaceRoot?: string
}): string | undefined {
  const referenced: string[] = []
  const modified: string[] = []
  for (const turn of params.historyTurns.slice(-12)) {
    for (const message of turn.messages) {
      if (message.role !== 'assistant') continue
      for (const call of message.toolCalls ?? []) {
        const paths: string[] = []
        extractPathLikeValues(argsForEvent(call.arguments), paths)
        const target = /write|edit|delete|apply|replace/i.test(call.name) ? modified : referenced
        for (const p of paths) pushUnique(target, p)
      }
    }
  }

  const lines: string[] = []
  if (params.workspaceRoot) lines.push(`Workspace: ${params.workspaceRoot}`)
  if (params.activeFilePath) lines.push(`Active file: ${params.activeFilePath}`)
  if (referenced.length) lines.push(`Recently referenced files: ${referenced.join(', ')}`)
  if (modified.length) lines.push(`Recently modified files: ${modified.join(', ')}`)
  return lines.length > 0 ? lines.join('\n') : undefined
}


interface HistoryTurn {
  turnId: string
  messages: ChatMessage[]
}

// 孤儿 tool_use 配对补全：确保每个 assistant 发起的工具调用（tool_use）后面都有
// 对应的 tool 结果。用户在工具执行阶段点「停止」时，带 toolCalls 的 assistant 消息
// 已入 turnMessages，但对应的 tool 结果尚未 push——这会在历史里留下「有 tool_use、
// 无 tool_result」的残缺回合。Anthropic 对此零容忍（400: tool_use ids were found
// without tool_result blocks），OpenAI 通道虽有清洗但也应从源头补齐。
// 本函数在「历史提交」这一必经路径上运行：为所有缺失结果的调用补一条「已取消」占位，
// 就地插到该 assistant 之后，保证 tool_use / tool_result 严格配对。无孤儿时零改动。
function reconcileOrphanToolCalls(messages: ChatMessage[]): ChatMessage[] {
  const resultIds = new Set<string>()
  for (const m of messages) {
    if (m.role === 'tool' && m.toolCallId) resultIds.add(m.toolCallId)
  }
  const out: ChatMessage[] = []
  for (const m of messages) {
    out.push(m)
    if (m.role !== 'assistant' || !m.toolCalls?.length) continue
    for (const tc of m.toolCalls) {
      if (resultIds.has(tc.id)) continue
      out.push({
        role: 'tool',
        toolCallId: tc.id,
        content: '工具调用已取消（用户停止了本轮生成，该调用未执行或未返回结果）。'
      })
      resultIds.add(tc.id)
    }
  }
  return out
}

export class QueryEngine {
  private historyTurns: HistoryTurn[] = []
  private active: AbortController | null = null
  private registry: ToolRegistry
  private permissionEngine = new PermissionEngine()
  private broker = new PermissionBroker()
  private fileChangeBroker = new FileChangeBroker()
  private userQuestionBroker = new UserQuestionBroker()
  private checkpoint = new TurnCheckpoint()
  private fileChangeHistory = new FileChangeHistory()
  private hookRunner = new HookRunner()
  private compactFailureCount = 0
  private snippedTurnIds = new Set<string>()
  private contentReplacementState: ContentReplacementState = createContentReplacementState()
  private workspaceRootOverride: string | null = null
  private lastMemoryRoot: string | null = null
  private lastPromptCacheSnapshot?: { signature: string; hitRate: number }
  // 空闲记忆反思：turn 结束不立即跑反思（那会额外发一次 LLM 请求，与主对话抢同一
  // Provider 连接/并发配额，表现为"记笔记后卡 ~10 秒"）。改为登记一个延迟任务，
  // 若窗口内本会话又开新 turn 则取消顺延，真正空闲时才执行，彻底避开资源争用。
  private pendingReflect: { timer: NodeJS.Timeout; run: () => void } | null = null

  constructor(registry: ToolRegistry = buildDefaultRegistry()) {
    this.registry = registry
  }

  // 会话空闲多久后才执行记忆反思（毫秒）。窗口内有新 turn 则取消重排。
  private static readonly IDLE_REFLECT_DELAY_MS = 8000

  // 取消挂起的空闲反思（新 turn 开始或引擎清理时调用）。
  private cancelPendingReflect(): void {
    if (this.pendingReflect) {
      clearTimeout(this.pendingReflect.timer)
      this.pendingReflect = null
    }
  }

  // 登记一个"空闲后执行"的反思任务：延迟 IDLE_REFLECT_DELAY_MS 执行，
  // 期间若被 cancelPendingReflect 取消（本会话又开新 turn）则不执行。
  private scheduleIdleReflect(run: () => void): void {
    this.cancelPendingReflect()
    const timer = setTimeout(() => {
      this.pendingReflect = null
      run()
    }, QueryEngine.IDLE_REFLECT_DELAY_MS)
    // 反思是纯后台巩固，不应拖住进程退出。
    timer.unref?.()
    this.pendingReflect = { timer, run }
  }

  cancel(sessionId?: string): void {
    this.cancelPendingReflect()
    this.active?.abort()
    this.broker.cancelAll()
    this.fileChangeBroker.cancelAll()
    this.userQuestionBroker.cancelAll()
    if (sessionId) cancelSessionBackgroundTools(sessionId)
  }

  
  resolvePermission(requestId: string, decision: PermissionDecision): void {
    this.broker.resolve(requestId, decision)
  }

  
  resolveFileChange(changeId: string, decision: FileChangeDecision): void {
    this.fileChangeBroker.resolve(changeId, decision)
  }

  
  resolveUserQuestion(requestId: string, response: UserQuestionResponse): void {
    this.userQuestionBroker.resolve(requestId, response)
  }

  
  canRevert(): boolean {
    return this.checkpoint.hasRevertable()
  }

  
  revertCheckpoint(): Promise<number> {
    return this.checkpoint.revert()
  }

  /** 撤销单个已应用的文件变更（按 changeId）。 */
  async revertFileChange(changeId: string): Promise<{ ok: boolean; reason?: string }> {
    if (!this.fileChangeHistory.hasRecord(changeId)) {
      return { ok: false, reason: 'not_found' }
    }
    const path = this.fileChangeHistory.pathOf(changeId)
    if (path && isPathDirty(path, new Set())) {
      return { ok: false, reason: 'dirty' }
    }
    const ok = await this.fileChangeHistory.revert(changeId)
    return ok ? { ok: true } : { ok: false, reason: 'failed' }
  }

  /** 取消撤销单个文件变更，重新写回 AI 的修改（按 changeId）。 */
  async redoFileChange(changeId: string): Promise<{ ok: boolean; reason?: string }> {
    if (!this.fileChangeHistory.hasRecord(changeId)) {
      return { ok: false, reason: 'not_found' }
    }
    const path = this.fileChangeHistory.pathOf(changeId)
    if (path && isPathDirty(path, new Set())) {
      return { ok: false, reason: 'dirty' }
    }
    const ok = await this.fileChangeHistory.redo(changeId)
    return ok ? { ok: true } : { ok: false, reason: 'failed' }
  }

  clear(sessionId?: string): void {
    this.cancelPendingReflect()
    this.historyTurns = []
    this.snippedTurnIds.clear()
    this.contentReplacementState = createContentReplacementState()
    this.compactFailureCount = 0
    this.workspaceRootOverride = null
    this.permissionEngine.reset()
    this.fileChangeHistory.clear()
    if (sessionId) clearSessionBackgroundTools(sessionId)
    this.registry.clearDiscoveredDeferredTools()
    resetTasks(sessionId)
  }

  
  restoreHistory(
    messages: ChatMessage[],
    replacementRecords?: readonly ContentReplacementRecord[],
    discoveredDeferredTools?: readonly string[]
  ): void {
    restoreDeferredToolDiscovery(this.registry, messages, discoveredDeferredTools)
    if (this.historyTurns.length > 0) {
      if (replacementRecords?.length && this.contentReplacementState.seenIds.size === 0) {
        this.contentReplacementState = createContentReplacementStateFromRecords(replacementRecords)
      }
      return
    }
    this.contentReplacementState = createContentReplacementStateFromRecords(replacementRecords)
    if (messages.length === 0) return
    this.historyTurns = [{ turnId: 'restored', messages }]
  }

  exportContentReplacementRecords(): ContentReplacementRecord[] {
    return exportContentReplacementRecords(this.contentReplacementState)
  }

  exportDiscoveredDeferredTools(): string[] {
    return this.registry.discoveredDeferredToolNames()
  }

  exportFileChanges(): PersistedFileChange[] {
    return this.fileChangeHistory.export()
  }

  snapshotHistoryWithTurn(turnMessages: ChatMessage[]): PersistedChatMessage[] {
    return [
      ...this.exportHistoryMessages(),
      ...reconcileOrphanToolCalls(turnMessages).map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.toolCalls?.length
          ? { toolCalls: m.toolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })) }
          : {}),
        ...(m.toolCallId ? { toolCallId: m.toolCallId } : {})
      }))
    ].filter((m) => typeof m.content === 'string')
  }

  persistTurnCheckpoint(sessionId: string, turnId: string, turnMessages: ChatMessage[], reason: PersistedSessionInProgressReason = 'backend_checkpoint'): void {
    if (!sessionId || sessionId === 'default') return
    const existing = loadSession(sessionId)
    if (!existing) return
    const now = Date.now()
    try {
      saveSession({
        ...existing,
        updatedAt: now,
        history: this.snapshotHistoryWithTurn(turnMessages),
        replacementRecords: this.exportContentReplacementRecords(),
        discoveredDeferredTools: this.exportDiscoveredDeferredTools(),
        fileChanges: this.exportFileChanges(),
        inProgress: {
          turnId,
          startedAt: existing.inProgress?.turnId === turnId ? existing.inProgress.startedAt : now,
          lastEventAt: now,
          reason
        }
      })
    } catch {
      
    }
  }

  restoreFileChanges(items: readonly PersistedFileChange[] | undefined): void {
    this.fileChangeHistory.restore(items)
  }

  // 导出可持久化的历史消息。供通道层跨重启续接保存。
  // 必须保留 toolCalls/toolCallId：否则恢复后 assistant 的工具调用与 tool 结果脱钩，
  // 历史不合规，严格的 Provider 会整请求报错（Messages with role 'tool' must follow tool_calls）。
  exportHistoryMessages(): PersistedChatMessage[] {
    return this.visibleHistoryTurns()
      .flatMap((t) => t.messages)
      .map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.toolCalls?.length
          ? { toolCalls: m.toolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })) }
          : {}),
        ...(m.toolCallId ? { toolCallId: m.toolCallId } : {})
      }))
  }

  // MCP 配置变更后，把最新的 MCP 工具同步进本会话的 registry。
  resyncMcpTools(): void {
    syncMcpToolsIntoRegistry(this.registry)
  }

  hasHistory(): boolean {
    return this.historyTurns.length > 0
  }

  private visibleHistoryTurns(): HistoryTurn[] {
    return this.historyTurns.filter((t) => !this.snippedTurnIds.has(t.turnId))
  }

  private flattenModelHistory(): ChatMessage[] {
    return this.visibleHistoryTurns().flatMap((t) => t.messages)
  }

  private inspectModelContext(model = 'gpt-4o'): ToolResult {
    const visible = this.visibleHistoryTurns()
    const hidden = this.historyTurns.length - visible.length
    const messages = visible.flatMap((t) => t.messages.map((m) => ({ turnId: t.turnId, ...m })))
    const totalTokens = countChatMessagesTokens(messages, model)
    const toolMessages = messages.filter((m) => m.role === 'tool')
    const rows = [
      `turns: ${visible.length} visible / ${this.historyTurns.length} total (${hidden} snipped)`,
      `messages: ${messages.length}`,
      `roughTokens: ${totalTokens}`,
      `toolMessages: ${toolMessages.length}`,
      `workspaceOverride: ${this.workspaceRootOverride ?? '(none)'}`,
      '',
      'recentTurns:',
      ...visible.slice(-10).map((turn) => `- ${turn.turnId}: ${turn.messages.map((m) => m.role).join(',')}`),
      '',
      visible.length > 6 ? `suggestion: snip_history with keepRecentTurns=4 or 6 can free older turns.` : 'suggestion: no compaction needed yet.'
    ]
    return { content: rows.join('\n') }
  }

  private replaceHistoryAfterCompact(turns: HistoryTurn[]): void {
    this.historyTurns = turns
    const remaining = new Set(turns.map((t) => t.turnId))
    for (const id of [...this.snippedTurnIds]) {
      if (!remaining.has(id)) this.snippedTurnIds.delete(id)
    }
  }

  /**
   * 压缩发生后，从「压缩前的可见轮次」里取出被丢弃（即不在压缩后结果中）的消息，
   * 派发 checkpoint-writer 做结构化提取。best-effort：失败不影响主对话。
   * 注意：writer 通过独立的 system+user 调 LLM，不进主历史、不参与主缓存键，
   * 对主对话提示词缓存零影响。
   *
   * writer 成功后，把结构化 checkpoint 渲染成 rebuild 注入块并就地并入压缩
   * 生成的 summary turn（afterTurns 中标记了 compactMeta 的那个）。该 turn 在
   * 压缩瞬间一次性生成、之后固定，故注入不产生任何额外缓存失效。
   */
  /**
   * 用户主动触发的上下文压缩（对应聊天里的 /compact 指令）。
   *
   * 复用自动压缩的全部机制（maybeCompactTurns + checkpoint writer + 记忆反思），
   * 差别仅在于：force=true 强制压缩、type='manual' 标记来源，且不依赖某一轮 turn。
   * 空闲（非流式）时调用；返回是否真的压缩了及压缩前的 token 估算，供上层反馈。
   */
  async compactNow(payload: {
    sessionId?: string
    profileId?: string | null
    workspaceRoot?: string | null
    activeFilePath?: string
  }): Promise<{ compacted: boolean; preTokens?: number; reason?: string }> {
    if (this.active) return { compacted: false, reason: 'busy' }
    if (this.visibleHistoryTurns().length <= 2) return { compacted: false, reason: 'too_short' }

    const profileId =
      (payload.profileId && getProfileRaw(payload.profileId) ? payload.profileId : null) ??
      getActiveProfileId()
    const profile = profileId ? getProfileRaw(profileId) : null
    if (!profile) return { compacted: false, reason: 'no_profile' }

    const workspaceRoot = this.workspaceRootOverride ?? payload.workspaceRoot ?? undefined
    const ctx: PromptContext = {
      appName: APP_NAME,
      os: process.platform,
      date: todayISODate(),
      shell: currentShellName(),
      responseLanguage: DEFAULT_RESPONSE_LANGUAGE,
      workspacePath: workspaceRoot,
      activeFilePath: payload.activeFilePath,
      model: profile.model,
      enabledTools: this.registry.availableTools().map((t) => t.name),
      permissionMode: 'default'
    }

    const controller = new AbortController()
    const signal = controller.signal
    let adapter
    try {
      adapter = createAdapter(profile, getActiveProfileApiKey())
    } catch {
      return { compacted: false, reason: 'adapter_error' }
    }

    let systemText: string
    try {
      systemText = assembleSystemMessage(await fetchSystemPromptPartsAsync(ctx, signal))
    } catch {
      systemText = ''
    }

    const summarize = async (sumMessages: ChatMessage[]): Promise<string> => {
      let text = ''
      for await (const chunk of adapter.streamChat(
        { model: profile.model, messages: sumMessages, maxOutputTokens: 1024, promptCache: buildPromptCacheOptions(profile.kind) },
        signal
      )) {
        if (chunk.type === 'text') text += chunk.text
      }
      return text
    }

    const meta = lookupModelMetadata(profile.kind, profile.model)
    const contextWindow = profile.contextWindow ?? meta.contextWindow ?? 500_000
    const restoreHints = buildCompactRestoreHints({
      historyTurns: this.historyTurns,
      activeFilePath: payload.activeFilePath,
      workspaceRoot
    })

    try {
      const beforeTurns = this.visibleHistoryTurns()
      const { turns, compacted, preCompactTokens } = await maybeCompactTurns({
        turns: beforeTurns,
        model: profile.model,
        kind: profile.kind,
        contextWindow,
        summarize,
        systemTokens: estimateSystemTokens(systemText, profile.model, profile.kind),
        maxOutputTokens: profile.maxOutputTokens,
        force: true,
        type: 'manual',
        restoreHints
      })
      if (!compacted) return { compacted: false, reason: 'nothing_to_compact' }
      this.replaceHistoryAfterCompact(turns)
      this.compactFailureCount = 0
      void this.runCheckpointWriterFor({
        sessionId: payload.sessionId || 'default',
        turnId: `manual-compact-${Date.now()}`,
        model: profile.model,
        beforeTurns,
        afterTurns: turns,
        summarize
      })
      return { compacted: true, preTokens: preCompactTokens }
    } catch {
      return { compacted: false, reason: 'error' }
    }
  }

  private async runCheckpointWriterFor(params: {
    sessionId: string
    turnId: string
    model: string
    beforeTurns: HistoryTurn[]
    afterTurns: HistoryTurn[]
    summarize: (messages: ChatMessage[]) => Promise<string>
  }): Promise<void> {
    if (!getMemorySettings().writerEnabled) return
    const keptIds = new Set(params.afterTurns.map((t) => t.turnId))
    const discardedMessages = params.beforeTurns
      .filter((t) => !keptIds.has(t.turnId))
      .flatMap((t) => t.messages)
    if (discardedMessages.length === 0) return
    try {
      const ok = await runCheckpointWriter({
        sessionId: params.sessionId,
        turnId: params.turnId,
        model: params.model,
        discardedMessages,
        summarize: params.summarize
      })
      if (!ok) return
      // rebuild 注入：把结构化 checkpoint 并入压缩 summary turn。
      const injection = await buildRebuildInjection({
        sessionId: params.sessionId,
        model: params.model
      })
      if (injection) this.injectRebuildIntoSummaryTurn(params.afterTurns, injection)
      // 方案 D：压缩点对"被丢弃的对话片段"批量反思提取，补全跨会话该留的事实（兜底，防漏记）。
      // 随后再睡眠巩固——先把新事实落库，巩固时即可一并蒸馏。均 fire-and-forget，失败静默。
      const memRoot = this.lastMemoryRoot
      const discardedForReflect = discardedMessages.filter(
        (m) => (m.role === 'user' || m.role === 'assistant') && (m.content ?? '').trim()
      )
      void import('../memory/reflection')
        .then(({ reflectAndEncode }) =>
          discardedForReflect.length > 0
            ? reflectAndEncode({
                sessionId: params.sessionId,
                messages: discardedForReflect,
                workspaceRoot: memRoot
              })
            : 0
        )
        .then(() => {
          if (memRoot) {
            return import('../memory/consolidate').then(({ consolidateProject }) =>
              consolidateProject(memRoot)
            )
          }
        })
        .catch(() => {})
    } catch {
      // best-effort
    }
  }

  /**
   * 把 rebuild 注入块追加到压缩 summary turn 的首条消息内容末尾。
   * summary turn 通过 compactMeta 识别；找不到则追加到第一个 turn 的首条消息。
   * 直接改 afterTurns 内的消息对象（调用方随后用它 replaceHistoryAfterCompact）。
   */
  private injectRebuildIntoSummaryTurn(turns: HistoryTurn[], injection: string): void {
    const target =
      turns.find((t) => (t as { compactMeta?: unknown }).compactMeta) ?? turns[0]
    if (!target || target.messages.length === 0) return
    const first = target.messages[0]
    target.messages[0] = {
      ...first,
      content: `${first.content ?? ''}\n\n${injection}`
    }
  }

  private applySnipHistory(req: SnipHistoryRequest): ToolResult {
    const candidateIds = new Set<string>()
    if (req.turnIds?.length) {
      for (const id of req.turnIds) candidateIds.add(id)
    }
    if (req.beforeTurnId) {
      const idx = this.historyTurns.findIndex((t) => t.turnId === req.beforeTurnId)
      if (idx < 0) return { content: `未找到 beforeTurnId：${req.beforeTurnId}`, isError: true }
      for (const turn of this.historyTurns.slice(0, idx)) candidateIds.add(turn.turnId)
    }
    if (req.keepRecentTurns !== undefined) {
      const visible = this.visibleHistoryTurns()
      const remove = visible.slice(0, Math.max(0, visible.length - req.keepRecentTurns))
      for (const turn of remove) candidateIds.add(turn.turnId)
    }

    const existingIds = new Set(this.historyTurns.map((t) => t.turnId))
    const ids = [...candidateIds].filter((id) => existingIds.has(id) && !this.snippedTurnIds.has(id))
    if (ids.length === 0) {
      return { content: '没有可 snip 的历史 turn。', isError: true }
    }
    for (const id of ids) this.snippedTurnIds.add(id)

    const markerId = `snip-${randomUUID()}`
    const marker = [
      `[History snipped: ${ids.length} turn(s) removed from model context]`,
      `Reason: ${req.reason}`,
      `Snipped turns: ${ids.join(', ')}`,
      'The full saved transcript is not deleted. Use search_history to recover details if needed.'
    ].join('\n')
    this.historyTurns.push({
      turnId: markerId,
      messages: [{ role: 'user', content: marker }]
    })
    return { content: `已 snip ${ids.length} 个历史 turn：${ids.join(', ')}。后续模型上下文会保留 snip marker，可用 search_history 回查细节。` }
  }

  
  private truncateHistoryFrom(turnId: string): void {
    const idx = this.historyTurns.findIndex((t) => t.turnId === turnId)
    if (idx >= 0) {
      this.historyTurns = this.historyTurns.slice(0, idx)
      const remaining = new Set(this.historyTurns.map((t) => t.turnId))
      for (const id of this.snippedTurnIds) {
        if (!remaining.has(id)) this.snippedTurnIds.delete(id)
      }
    }
  }

  private async runSingle(call: ToolCallRequest, ctx: ToolContext): Promise<ToolResult> {
    const args = parseToolArguments(call.arguments)
    if (args === undefined) {
      return { content: `工具参数 JSON 解析失败：${call.arguments}`, isError: true }
    }
    return this.registry.run(call.name, args, { ...ctx, toolCallId: call.id })
  }

  // 把一个工具调用解析为「实际要执行的工具 + 调用」。
  // 对 ExecuteExtraTool：若其目标延迟工具已被发现，则解包成对真实工具的直接调用，
  // 这样后台并发预热可以正确识别 GenerateImage 等延迟工具的 readOnly/background 属性。
  private resolveActiveCall(c: ToolCallRequest): { activeCall: ToolCallRequest; activeTool: Tool<unknown> | undefined } {
    let activeCall = c
    let activeTool = this.registry.get(c.name)
    if (c.name === EXECUTE_EXTRA_TOOL_NAME) {
      const args = argsForEvent(c.arguments)
      const targetName = typeof args.name === 'string' ? args.name : undefined
      const targetArgs = args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments)
        ? args.arguments
        : {}
      if (targetName && this.registry.isDeferredToolDiscovered(targetName)) {
        const targetTool = this.registry.get(targetName)
        if (targetTool) {
          activeTool = targetTool
          activeCall = { id: c.id, name: targetName, arguments: JSON.stringify(targetArgs) }
        }
      }
    }
    return { activeCall, activeTool }
  }

  async *submitTurn(payload: AiSendPayload): AsyncGenerator<AgentEvent, void, unknown> {
    // 新 turn 开始 = 会话不空闲：取消上一回合登记的空闲反思，顺延到下次真正空闲再跑，
    // 从根上避免反思的后台 LLM 请求与本轮主对话抢同一 Provider 资源。
    this.cancelPendingReflect()
    const turnId = payload.turnId
    // sessionCwd 区分「未提供(undefined) → 兼容旧路径回退编辑器工作区」与
    // 「显式 null（纯对话）→ 绝不回退」，避免纯对话泄漏当前工作区
    const effectiveWorkspaceRoot =
      this.workspaceRootOverride ??
      (payload.sessionCwd !== undefined
        ? payload.sessionCwd
        : (payload.editorContext?.workspaceRoot ?? null))

    // 记忆读写根：worktree 隔离时与文件 cwd 解耦（记忆绑定基础路径，不随临时副本漂移）。
    // 不显式提供则回退到文件 cwd，桌面/微信会话行为零变化。
    const effectiveMemoryRoot =
      payload.memoryWorkspaceRoot !== undefined
        ? payload.memoryWorkspaceRoot
        : effectiveWorkspaceRoot
    this.lastMemoryRoot = effectiveMemoryRoot

    // profile 优先级：payload 显式指定（群聊岗位按 seat.modelProfileId）> 全局激活 profile。
    // payload.profileId 指向的 profile 不存在时，回退到激活 profile（不硬失败）。
    const profileId =
      (payload.profileId && getProfileRaw(payload.profileId) ? payload.profileId : null) ??
      getActiveProfileId()
    const profile = profileId ? getProfileRaw(profileId) : null
    if (!profile) {
      yield {
        type: 'error',
        turnId,
        code: 'no_profile',
        message: '尚未配置或激活 Provider，请在设置中配置后重试。',
        retryable: false
      }
      return
    }

    yield { type: 'turn_start', turnId, profileId: profile.id }

    // 连接 MCP server 并把其工具同步进 registry（失败不影响本轮对话）。
    try {
      await ensureMcpReady(this.registry, effectiveWorkspaceRoot)
    } catch (e) {
      console.error('[mcp] 准备 MCP 工具失败:', e)
    }

    recordDebugEvent({
      kind: 'request_start',
      sessionId: payload.sessionId || 'default',
      turnId,
      label: profile.model,
      detail: `kind=${profile.kind}`
    })

    if (payload.resendOfTurnId) {
      this.truncateHistoryFrom(payload.resendOfTurnId)
    }

    const ctx: PromptContext = {
      appName: APP_NAME,
      os: process.platform,
      date: todayISODate(),
      shell: currentShellName(),
      responseLanguage: DEFAULT_RESPONSE_LANGUAGE,
      workspacePath: effectiveWorkspaceRoot ?? undefined,
      ...(effectiveMemoryRoot != null ? { memoryWorkspacePath: effectiveMemoryRoot } : {}),
      activeFilePath: payload.editorContext?.activeFilePath,
      model: profile.model,
      enabledTools: this.registry.availableTools().map((t) => t.name),
      permissionMode: payload.permissionMode ?? 'default',
      ...(payload.persona ? { persona: payload.persona } : {}),
      ...(payload.roomContext ? { roomContext: payload.roomContext } : {}),
      ...(payload.channel ? { channel: payload.channel } : {})
    }

    this.active = new AbortController()
    const signal = this.active.signal

    let currentToolDefs: ToolDef[] = this.registry.toToolDefs()
    const pendingToolEvents: AgentEvent[] = []
    let wakeToolEventLoop: (() => void) | undefined
    const wakePendingToolEventLoop = (): void => {
      const wake = wakeToolEventLoop
      wakeToolEventLoop = undefined
      wake?.()
    }
    const waitForPendingToolEvent = (): Promise<void> => new Promise((resolve) => {
      wakeToolEventLoop = resolve
    })
    const runWithLiveToolEvents = async function* <T>(promise: Promise<T>): AsyncGenerator<AgentEvent, T, unknown> {
      let settled = false
      let value: T | undefined
      let error: unknown
      promise.then(
        (result) => {
          settled = true
          value = result
          wakePendingToolEventLoop()
        },
        (err) => {
          settled = true
          error = err
          wakePendingToolEventLoop()
        }
      )

      while (!settled || pendingToolEvents.length > 0) {
        while (pendingToolEvents.length > 0) {
          const event = pendingToolEvents.shift()
          if (event) yield event
        }
        if (settled) break
        await waitForPendingToolEvent()
      }

      if (error) throw error
      return value as T
    }
    const turnContentReplacementState = cloneContentReplacementState(this.contentReplacementState)
    const commitContentReplacementState = (): void => {
      this.contentReplacementState = turnContentReplacementState
    }
    const toolCtx: ToolContext = {
      workspaceRoot: effectiveWorkspaceRoot,
      memoryWorkspaceRoot: effectiveMemoryRoot,
      sessionId: payload.sessionId || 'default',
      signal,
      permissionMode: payload.permissionMode ?? 'default',
      snapshot: (p) => this.checkpoint.snapshot(p),
      turnId,
      emitEvent: (event) => {
        pendingToolEvents.push(event)
        wakePendingToolEventLoop()
      },
      parentMessages: this.flattenModelHistory(),
      contentReplacementState: turnContentReplacementState,
      requestSnipHistory: async (request) => this.applySnipHistory(request),
      requestWorkspaceRootChange: (workspaceRoot, reason) => {
        this.workspaceRootOverride = workspaceRoot
        pendingToolEvents.push({ type: 'workspace_root_changed', turnId, workspaceRoot, reason })
        wakePendingToolEventLoop()
      },
      inspectContext: () => this.inspectModelContext(profile.model),
      requestUserQuestion: async (question, suggestions, options) => {
        const requestId = randomUUID()
        pendingToolEvents.push({
          type: 'user_question',
          turnId,
          requestId,
          question,
          suggestions,
          previewImageId: options?.previewImageId
        })
        wakePendingToolEventLoop()
        const response = await this.userQuestionBroker.wait(requestId, signal)
        if (options?.previewImageId) {
          const previewId = options.previewImageId
          setTimeout(() => {
            void deleteBrowserPreview(previewId)
          }, 60_000)
        }
        pendingToolEvents.push({
          type: 'user_question_resolved',
          turnId,
          requestId,
          answer: response.answer,
          cancelled: response.cancelled
        })
        wakePendingToolEventLoop()
        return response
      }
    }

    // 用户粘贴/拖拽的图片：既作为多模态视觉内容发给模型"看"，也落盘成 codelf-artifact://
    // 本地路径并在文本里告知模型——这样模型可把它作为参考图传给 GenerateImage / GenerateVideo
    // 等工具（这些工具的入参要的是路径/URL，而非 dataUrl）。
    let attachedImagePaths: string[] = []
    if (payload.images?.length) {
      attachedImagePaths = await persistUserImages(payload.images)
    }

    const userMessageText = buildUserMessage(payload.message, payload.editorContext, payload.attachments, {
      model: profile.model,
      providerKind: profile.kind
    })
    const userMessageWithImages = attachedImagePaths.length
      ? `${userMessageText}\n\n${buildAttachedImagesNote(attachedImagePaths)}`
      : userMessageText

    const userMsg: ChatMessage = {
      content: userMessageWithImages,
      
      ...(profile.supportsVision && payload.images?.length
        ? { images: payload.images.map((i) => ({ dataUrl: i.dataUrl })) }
        : {}),
      role: 'user'
    }
    const turnMessages: ChatMessage[] = [userMsg]
    this.persistTurnCheckpoint(payload.sessionId || 'default', turnId, turnMessages, 'streaming')

    let adapter
    try {
      adapter = createAdapter(profile, getActiveProfileApiKey())
    } catch (e) {
      yield toErrorEvent(turnId, e)
      return
    }

    
    let systemText: string
    try {
      systemText = assembleSystemMessage(await fetchSystemPromptPartsAsync(ctx, signal))
    } catch (e) {
      yield toErrorEvent(turnId, e)
      return
    }

    // 权限模式标注随会话操作变化，单独注入到消息数组尾部（历史之后、当前轮之前），
    // 不写入历史。Git context 等仍在 system 内。
    const dynamicContextBlock = fetchDynamicContextBlock(ctx)

    // 知识库 RAG 自动注入：每轮用本轮问题检索一次知识库，渲染成带来源的上下文块。
    // 仅算一次（在工具循环外），随后合并进当前用户消息（避免独立 system 消息中断缓存前缀），不进历史。
    const knowledgeContextBlock = await buildKnowledgeContextBlock(payload.message)
    if (knowledgeContextBlock) {
      userMsg.content = `${knowledgeContextBlock}\n\n---\n\n${userMsg.content}`
    }

    // 主动联想召回：每轮用本轮输入向量召回相关情景记忆（跨会话/跨项目），合并进当前
    // 用户消息之前。与知识库 RAG 同构——只在 tail 新增，不进 system、不写历史，故对 prompt
    // 缓存前缀零破坏（promptCacheKey 只 hash 静态核心，不含召回内容）。best-effort。
    // 会话隔离：IM 通道（如微信）是线性一对一对话，且其专属工作区常与群聊主管共享
    // （记忆同源设计），若不隔离，群聊里其他会话往同一工作区写的项目待办/多岗位记忆
    // 会被无差别召回、污染微信对话。故微信轮次只召回「本会话自写的项目记忆 + 全局身份/偏好」。
    // 桌面端不带 channel → isolateSessionId 为 null，保持原跨会话召回行为不变。
    const recallBlock = await buildRecallInjection({
      query: payload.message,
      workspaceRoot: effectiveMemoryRoot,
      activeFile: payload.editorContext?.activeFilePath,
      isolateSessionId: payload.channel ? (payload.sessionId || null) : null
    })
    if (recallBlock) {
      userMsg.content = `${recallBlock}\n\n---\n\n${userMsg.content}`
    }

    const staticSystemCore = getStaticSystemCore(ctx)
    const promptCacheKey = buildPromptCacheKey({
      sessionId: payload.sessionId,
      profileId: profile.id,
      providerKind: profile.kind,
      model: profile.model,
      workspaceRoot: effectiveWorkspaceRoot ?? undefined,
      staticSystemCore
    })
    const promptCacheSignature = [payload.sessionId || 'default', profile.id, profile.kind, profile.model, effectiveWorkspaceRoot || ''].join('\n')
    const promptCache = buildPromptCacheOptions(profile.kind)

    const behavior = getAgentBehaviorSettings()
    this.registry.configureDeferredPolicy(behavior)
    const maxToolSteps = behavior.maxToolSteps
    const maxTurnDurationMs = behavior.maxTurnDurationMs
    const acceptEdits = payload.permissionMode === 'acceptEdits'
    const dirtySet = new Set(
      (payload.editorContext?.dirtyPaths ?? []).map((p) => p.replace(/\\/g, '/').toLowerCase())
    )
    const isDirty = (abs: string): boolean => isPathDirty(abs, dirtySet)
    this.permissionEngine.loadRules(effectiveWorkspaceRoot)
    this.hookRunner.load(effectiveWorkspaceRoot)
    this.checkpoint.beginTurn()
    const started = Date.now()
    let usage: TokenUsage | undefined
    let cancelled = false
    let steps = 0
    
    
    let sideEffected = false
    let contentReplacementCommitted = false
    let hasAttemptedReactiveCompact = false
    let lengthContinuationCount = 0
    const MAX_LENGTH_CONTINUATIONS = 8
    // 空响应兜底：模型/中转在某轮返回完全空（无文字、无工具调用）时自动重试，
    // 而不是静默结束。达上限则明确报错，根治"发消息没反应、自动结束输出"的现象。
    let emptyResponseRetryCount = 0
    const MAX_EMPTY_RESPONSE_RETRIES = 3
    // 「防假完成」：本轮用户是否请求出图、是否真正调用过图像工具、已纠正次数。
    const imageIntent = userAskedForImage(payload.message)
    let imageToolInvokedThisTurn = false
    let fakeImageCorrectionCount = 0
    const MAX_FAKE_IMAGE_CORRECTIONS = 1
    // 「防假完成」（文件编辑）：本轮用户是否请求改写/编辑文件、本轮是否真正发生过文件写入、已纠正次数。
    const editIntent = userAskedForFileEdit(payload.message)
    let fileChangeAppliedThisTurn = false
    let fakeEditCorrectionCount = 0
    const MAX_FAKE_EDIT_CORRECTIONS = 1
    const denials = new DenialTracker()
    const permOpts = {
      permissionMode: payload.permissionMode ?? ('default' as const),
      workspaceRoot: effectiveWorkspaceRoot
    }

    // 各种提前退出路径（turn_limit / denial_limit / 空响应兜底等）在此提交本轮已产生的内容。
    // 判据为「turnMessages 除初始 user 消息外还有实质产出」，而非仅 sideEffected：
    // 只读探索回合（读文件、搜索、跑工具）不置 sideEffected，若沿用旧判据会被整轮丢弃，
    // 用户重试时上下文全失、从头重来。
    const commitPartialIfSideEffected = (): void => {
      if (turnMessages.length <= 1) return
      this.historyTurns.push({ turnId, messages: reconcileOrphanToolCalls(turnMessages) })
      commitContentReplacementState()
      contentReplacementCommitted = true
    }

    // --- Hooks: SessionStart (first turn only) + UserPromptSubmit ---
    const hookCwd = effectiveWorkspaceRoot || process.cwd()
    const hookBase = {
      session_id: payload.sessionId || 'default',
      cwd: hookCwd,
      ...(payload.permissionMode ? { permission_mode: payload.permissionMode } : {})
    }
    const injectedHookContext: string[] = []
    if (!this.hasHistory() && this.hookRunner.hasAny('SessionStart')) {
      const r = await this.hookRunner.dispatch(
        'SessionStart',
        { ...hookBase, hook_event_name: 'SessionStart', source: 'startup' } as HookInput,
        'startup',
        signal
      )
      injectedHookContext.push(...r.additionalContext)
    }
    if (this.hookRunner.hasAny('UserPromptSubmit')) {
      const r = await this.hookRunner.dispatch(
        'UserPromptSubmit',
        { ...hookBase, hook_event_name: 'UserPromptSubmit', prompt: payload.message } as HookInput,
        undefined,
        signal
      )
      injectedHookContext.push(...r.additionalContext)
      if (r.blocked) {
        yield { type: 'error', turnId, code: 'hook_blocked', message: r.blockReason || '请求被 hook 阻止', retryable: false }
        return
      }
    }
    for (const ctxText of injectedHookContext) {
      turnMessages.push({ role: 'user', content: systemReminder(ctxText) })
    }

    const meta = lookupModelMetadata(profile.kind, profile.model)
    const contextWindow = profile.contextWindow ?? meta.contextWindow ?? 500_000

    const summarize = async (sumMessages: ChatMessage[]): Promise<string> => {
      let text = ''
      for await (const chunk of adapter.streamChat(
        { model: profile.model, messages: sumMessages, maxOutputTokens: 1024, promptCacheKey, promptCache },
        signal
      )) {
        if (chunk.type === 'text') text += chunk.text
      }
      return text
    }
    // checkpoint-writer 专用 LLM 回调：输出预算更大（容纳完整 11 节 checkpoint），
    // 且不复用主会话的 promptCacheKey —— writer 的 prefix 与主对话不同，
    // 复用会污染缓存。不传 promptCacheKey 即按独立请求处理，对主缓存零影响。
    const writerComplete = async (writerMessages: ChatMessage[]): Promise<string> => {
      let text = ''
      for await (const chunk of adapter.streamChat(
        { model: profile.model, messages: writerMessages, maxOutputTokens: 8192, promptCache },
        signal
      )) {
        if (chunk.type === 'text') text += chunk.text
      }
      return text
    }
    const restoreHints = buildCompactRestoreHints({
      historyTurns: this.historyTurns,
      activeFilePath: payload.editorContext?.activeFilePath,
      workspaceRoot: effectiveWorkspaceRoot ?? undefined
    })

    
    
    if (this.compactFailureCount < 3) {
      try {
        const beforeTurns = this.visibleHistoryTurns()
        const { turns, compacted, reason, preCompactTokens } = await maybeCompactTurns({
          turns: beforeTurns,
          model: profile.model,
          kind: profile.kind,
          contextWindow,
          summarize,
          systemTokens: estimateSystemTokens(systemText, profile.model, profile.kind),
          maxOutputTokens: profile.maxOutputTokens,
          predictive: true,
          restoreHints
        })
        if (compacted) {
          this.compactFailureCount = 0
          // 先落地压缩后的历史，让本轮请求立即可以继续，不被 writer 阻塞。
          this.replaceHistoryAfterCompact(turns)
          // checkpoint writer（8192 token 输出，含 rebuild 注入）是压缩链路里最慢的一环。
          // 改为后台异步执行：它与本轮主对话并行跑，不再让用户在“发消息触发压缩”时卡住。
          // writer 完成后仍就地改 turns（此时 === this.historyTurns 引用）里的 summary turn，
          // rebuild 注入块在下一轮生效；best-effort，失败静默。
          void this.runCheckpointWriterFor({
            sessionId: payload.sessionId || 'default',
            turnId,
            model: profile.model,
            beforeTurns,
            afterTurns: turns,
            summarize: writerComplete
          })
          recordDebugEvent({
            kind: 'compact',
            sessionId: payload.sessionId || 'default',
            turnId,
            label: profile.model,
            detail: `auto-compact triggered (${reason ?? 'threshold'}, pre=${preCompactTokens ?? 0})`
          })
          yield {
            type: 'notice',
            turnId,
            message:
              reason === 'predictive'
                ? '上下文可能在本轮继续增长后接近上限，已提前压缩早期对话以释放空间，'
                : '上下文较长，已自动压缩早期对话以释放空间，'
          }
        }
      } catch {
        this.compactFailureCount += 1
      }
    }

    // 发送前预估：本轮请求真正发出去之前先算一次上下文用量，让 UI 的圆环立刻刷新，
    // 不必等整轮 turn_end。turn_end 会用带 API 真实 token 的值覆盖这里的预估。best-effort。
    try {
      const priorHistory = this.flattenModelHistory()
      const preBreakdown = await buildContextBreakdown({
        ctx,
        toolDefs: currentToolDefs,
        history: priorHistory,
        fullUserContent: userMsg.content,
        rawUserMessage: payload.message,
        model: profile.model,
        kind: profile.kind,
        contextWindow,
        signal
      })
      yield {
        type: 'context_estimate',
        turnId,
        usage: {
          inputTokens: preBreakdown.totalTokens,
          outputTokens: 0,
          estimatedPromptTokens: preBreakdown.totalTokens,
          contextBreakdown: preBreakdown
        }
      }
    } catch {
      
    }

    try {
      
      while (true) {
        if (maxTurnDurationMs > 0 && Date.now() - started > maxTurnDurationMs) {
          commitPartialIfSideEffected()
          yield {
            type: 'error',
            turnId,
            code: 'turn_limit',
            message: '已达单轮最长执行时间，已停止。',
            retryable: false
          }
          return
        }

        currentToolDefs = this.registry.toToolDefs()
        const deferredToolsAnnouncement = buildDeferredToolsAnnouncement(this.registry)
        // 「当前任务焦点」边界：仅在存在历史时注入，提醒模型以最新用户指令为准，
        // 避免被历史里未收尾的旧任务带跑。每轮重建、不写入历史，对缓存前缀无影响。
        const focusBoundaryBlock = this.visibleHistoryTurns().length > 0
          ? systemReminder(
              '下面 user 消息中的内容是用户当前轮的最新指令，是你此刻唯一要优先完成的任务。如果它与历史对话中尚未收尾的工作不同，以最新指令为准，不要默认延续上一轮未完成的任务——除非用户明确说"继续"。开始前先确认清楚当前要做的是哪件事。'
            )
          : undefined
        const assembledMessages: ChatMessage[] = [
          { role: 'system', content: systemText },
          ...this.flattenModelHistory(),
          ...(dynamicContextBlock ? [{ role: 'system' as const, content: dynamicContextBlock }] : []),
          ...(deferredToolsAnnouncement ? [{ role: 'system' as const, content: deferredToolsAnnouncement }] : []),
          ...(focusBoundaryBlock ? [{ role: 'system' as const, content: focusBoundaryBlock }] : []),
          ...turnMessages
        ]
        // 当前模型明确不支持视觉时，主动剥掉历史里残留的图片块（如上一轮用视觉模型
        // 粘图后切到纯文本模型），从源头避免带 image_url 触发 400。supportsVision 为
        // undefined 的旧配置不动，仍走 provider 层的错误自愈。
        const visionAdjusted =
          profile.supportsVision === false ? stripImagesForNonVision(assembledMessages) : assembledMessages
        // 发送前最后一道闸门：对「完整历史 + 当前轮」整体补齐孤儿 tool_use。
        // 各入历史路径的 reconcile 只作用于单轮 turnMessages，无法覆盖跨轮/跨重启
        // 恢复丢失 tool_result 的历史残缺；而真正发给 Provider 的是这里的完整列表。
        // 不在此补齐，严格通道（Anthropic/Bedrock 经中转）会报
        // 400: `tool_use` ids were found without `tool_result` blocks，且点重试仍发同一份坏历史、报同样错。
        // reconcile 幂等且只补占位不删除，无孤儿时零改动。
        const messages: ChatMessage[] = reconcileOrphanToolCalls(visionAdjusted)
        let acc = new ToolCallAccumulator()
        let roundText = ''
        let roundThinking = ''
        let carryText = ''
        let lastFinishReason: string | undefined
        const roundUsage = createRoundUsageAcc()

        const MAX_STREAM_RETRIES = 5
        let streamRetryCount = 0
        let streamDone = false

        try {
          while (!streamDone) {
            const requestMessages: ChatMessage[] = carryText
              ? [
                  ...messages,
                  { role: 'assistant', content: carryText },
                  { role: 'user', content: '[系统提示] 上一次回复因网络中断未发送完整。请直接从中断处继续输出，不要重复已经输出过的内容。' }
                ]
              : messages
            try {
              for await (const chunk of adapter.streamChat(
                {
                  model: profile.model,
                  messages: requestMessages,
                  maxOutputTokens: profile.maxOutputTokens,
                  ...(currentToolDefs.length ? { tools: currentToolDefs } : {}),
                  ...(profile.kind === 'dify' ? { sessionId: payload.sessionId || 'default' } : {}),
                  promptCacheKey,
                  promptCache,
                  ...(profile.kind === 'deepseek' && profile.thinkingMode
                    ? { thinking: { type: profile.thinkingMode } }
                    : {}),
                  ...((profile.kind === 'deepseek' || isKimiReasoningModel(profile.model)) &&
                  profile.reasoningEffort
                    ? { reasoningEffort: profile.reasoningEffort }
                    : {}),
                  ...(profile.imageGeneration ? { imageGeneration: true } : {})
                },
                signal
              )) {
                if (chunk.type === 'text') {
                  roundText += chunk.text
                  yield { type: 'text_delta', turnId, content: chunk.text }
                } else if (chunk.type === 'thinking') {
                  roundThinking += chunk.text
                  yield { type: 'thinking_delta', turnId, content: chunk.text }
                } else if (chunk.type === 'tool_call_delta') {
                  acc.add(chunk)
                  const snap = acc.snapshot(chunk.index)
                  if (snap) {
                    yield {
                      type: 'tool_call_delta',
                      turnId,
                      callId: snap.id,
                      name: snap.name || chunk.name,
                      argsText: snap.arguments,
                      argsDelta: chunk.argumentsDelta
                    }
                  }
                } else if (chunk.type === 'usage') {
                  applyStreamUsageChunk(roundUsage, chunk)
                } else if (chunk.type === 'image') {
                  if (chunk.partial) {
                    yield {
                      type: 'image_progress',
                      turnId,
                      index: chunk.index,
                      dataUrl: `data:${chunk.mediaType};base64,${chunk.base64}`
                    }
                  } else {
                    try {
                      const saved = await saveGeneratedImage(chunk.base64, chunk.mediaType)
                      const md = `\n\n![生成的图片](${saved.url})`
                      roundText += md
                      yield { type: 'text_delta', turnId, content: md }
                    } catch { /* 落盘失败则忽略该图 */ }
                  }
                } else if (chunk.type === 'done') {
                  lastFinishReason = chunk.finishReason
                }
              }
              usage = mergeRoundUsageIntoTurn(usage, roundUsage)
              roundText = carryText + roundText
              streamDone = true
            } catch (retryErr) {
              if (
                !signal.aborted &&
                streamRetryCount < MAX_STREAM_RETRIES &&
                isTransientNetworkError(retryErr)
              ) {
                streamRetryCount++
                // 关键：瞬断多是 keep-alive 连接池里的“僵尸 socket”被对端关闭。
                // 重试前销毁旧连接池，强制下一次请求新建 TCP 连接，避免反复命中坏连接。
                recycleOutboundDispatcher()
                // 首次退避就给足时间让坏连接被淘汰：3s / 5s / 7s（封顶 8s）。
                const delayMs = Math.min(2000 + 2000 * streamRetryCount, 8000)
                recordDebugEvent({
                  kind: 'request_error',
                  sessionId: payload.sessionId || 'default',
                  turnId,
                  label: 'stream_retry',
                  detail: `transient error, retry ${streamRetryCount}/${MAX_STREAM_RETRIES} after ${delayMs}ms: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`
                })
                await new Promise((r) => setTimeout(r, delayMs))
                if (signal.aborted) {
                  throw new ProviderError('cancelled', '已取消')
                }
                // 重置本次累加状态，避免把残缺的 tool-call JSON 与重连后的新数据混在一起。
                // 已输出的纯文本累积到 carryText，作为续写上下文；最终会与后续文本拼接。
                carryText += roundText
                roundText = ''
                roundThinking = ''
                acc = new ToolCallAccumulator()
                continue
              }
              throw retryErr
            }
          }
        } catch (e) {
          if (e instanceof ProviderError && e.code === 'cancelled') {
            turnMessages.push({ role: 'assistant', content: carryText + roundText })
            cancelled = true
            break
          }
          if (
            !hasAttemptedReactiveCompact &&
            !sideEffected &&
            roundText.length === 0 &&
            turnMessages.length === 1 &&
            isContextLengthError(e)
          ) {
            hasAttemptedReactiveCompact = true
            try {
              const beforeTurns = this.visibleHistoryTurns()
              const { turns, compacted, preCompactTokens } = await maybeCompactTurns({
                turns: beforeTurns,
                model: profile.model,
                kind: profile.kind,
                contextWindow,
                summarize,
                systemTokens: estimateSystemTokens(systemText, profile.model, profile.kind),
                maxOutputTokens: profile.maxOutputTokens,
                restoreHints,
                force: true,
                keepRecentTurns: Math.min(4, Math.max(1, this.historyTurns.length - 1))
              })
              if (compacted) {
                // 同上：先落地压缩结果并立即重试本轮，writer 丢后台，不阻塞重试。
                this.replaceHistoryAfterCompact(turns)
                this.compactFailureCount = 0
                void this.runCheckpointWriterFor({
                  sessionId: payload.sessionId || 'default',
                  turnId,
                  model: profile.model,
                  beforeTurns,
                  afterTurns: turns,
                  summarize: writerComplete
                })
                recordDebugEvent({
                  kind: 'compact',
                  sessionId: payload.sessionId || 'default',
                  turnId,
                  label: profile.model,
                  detail: `reactive-compact retry (pre=${preCompactTokens ?? 0})`
                })
                yield {
                  type: 'notice',
                  turnId,
                  message: 'Provider 返回上下文超限，已压缩早期对话并自动重试本轮请求。'
                }
                continue
              }
            } catch {
              this.compactFailureCount += 1
            }
          }
          // 报错时也把本轮已流式输出的半截文字（含续写累积的 carryText）落进历史，
          // 与「停止」一致：让用户点「重试」后模型仍能看到自己上次输出到哪，
          // 避免完全重来或重复劳动。即使本轮无副作用（纯聊天）也落。
          const partialAssistantText = carryText + roundText
          if (partialAssistantText.length > 0) {
            turnMessages.push({ role: 'assistant', content: partialAssistantText })
          }
          // 只要本轮已经产生了任何实质内容（此前若干轮的 assistant 文本、工具调用、
          // 工具结果，或本次半截文字），就落历史。注意 turnMessages[0] 恒为初始 user 消息，
          // 故 length > 1 表示有真实产出。之前用 sideEffected 判定会漏掉所有「只读探索」
          // 回合（read_file / search / grep / 读终端 等不置 sideEffected），导致中断重试时
          // 整个 turnMessages 被静默丢弃、模型完全看不到刚做过的事。
          if (turnMessages.length > 1) {
            this.historyTurns.push({ turnId, messages: reconcileOrphanToolCalls(turnMessages) })
            commitContentReplacementState()
            contentReplacementCommitted = true
          }
          yield toErrorEvent(turnId, e)
          return
        }

        const calls = acc.finalize()
        // 诊断日志（零行为影响）：记录本轮模型「解析后」的产出——文本/思考长度、
        // 工具调用数、finish_reason。用于对比不同模型/通道：若某模型每轮 toolCalls 恒为 0
        // 却有大段文本，基本可判定工具调用在上游（中转）被吞或模型未按工具协议返回。
        recordDebugEvent({
          kind: 'request_end',
          sessionId: payload.sessionId || 'default',
          turnId,
          label: 'round_result',
          detail: `kind=${profile.kind} model=${profile.model} toolsSent=${currentToolDefs.length} textLen=${roundText.trim().length} thinkingLen=${roundThinking.trim().length} toolCalls=${calls.length} finishReason=${lastFinishReason ?? 'none'}`
        })
        if (calls.length === 0) {
          // 模型因达到 max_tokens 被截断（finish_reason=length）时，自动续写而非静默结束，
          // 避免出现"输出戛然而止、无报错、按钮变回发送"的现象。
          if (
            lastFinishReason === 'length' &&
            roundText.length > 0 &&
            lengthContinuationCount < MAX_LENGTH_CONTINUATIONS &&
            !signal.aborted
          ) {
            lengthContinuationCount++
            recordDebugEvent({
              kind: 'request_end',
              sessionId: payload.sessionId || 'default',
              turnId,
              label: profile.model,
              detail: `length-truncated, auto-continue ${lengthContinuationCount}/${MAX_LENGTH_CONTINUATIONS}`
            })
            turnMessages.push({ role: 'assistant', content: roundText })
            turnMessages.push({
              role: 'user',
              content: systemReminder('上一条回复因达到输出长度上限被截断。请直接从中断处继续输出剩余内容，不要重复已经输出过的部分，也不要重新开头。')
            })
            continue
          }

          // 「防假完成」：用户要求出图、模型声称已完成、但本轮从未真正调用图像工具
          // （典型：某些中转模型幻觉式跳过工具直接说"已生成"）。注入纠正提示强制其真正调用，
          // 最多纠正一次，避免死循环。
          if (
            imageIntent &&
            !imageToolInvokedThisTurn &&
            fakeImageCorrectionCount < MAX_FAKE_IMAGE_CORRECTIONS &&
            claimsImageDone(roundText) &&
            !signal.aborted
          ) {
            fakeImageCorrectionCount++
            turnMessages.push({ role: 'assistant', content: roundText })
            turnMessages.push({
              role: 'user',
              content: systemReminder(
                `你声称已生成图片，但本轮并没有真正调用图像生成工具，因此用户那边并没有出现任何图片。不要假装完成。请立即真正执行：先用 SearchExtraTools（query="select:${GENERATE_IMAGE_NAME}"）发现工具，再用 ExecuteExtraTool 以 {"name":"${GENERATE_IMAGE_NAME}","arguments":{"prompt":"<根据用户需求润色后的英文或中文提示词>"}} 实际调用。生成成功前不要再回复"已生成"之类的话。`
              )
            })
            continue
          }

          // 「防假完成」（文件编辑）：用户要求改写/编辑文件、模型声称已完成、但本轮从未真正写入任何文件
          // （典型：模型"思考一会"后直接说"已修改"，却没调用 edit_file/write_file，用户那边毫无变化）。
          // 注入纠正提示强制其真正执行，最多纠正一次，避免死循环。
          // 例外：模型明确判断"该文件无需修改"是正当结论，不在此拦截（否则会逼它去改本不该改的文件）。
          if (
            editIntent &&
            !fileChangeAppliedThisTurn &&
            fakeEditCorrectionCount < MAX_FAKE_EDIT_CORRECTIONS &&
            claimsEditDone(roundText) &&
            !claimsNoEditNeeded(roundText) &&
            !signal.aborted
          ) {
            fakeEditCorrectionCount++
            turnMessages.push({ role: 'assistant', content: roundText })
            turnMessages.push({
              role: 'user',
              content: systemReminder(
                '你声称已经修改/编辑了文件，但本轮并没有真正调用任何文件写入工具（如 edit_file / write_file），因此用户的文件没有发生任何改动。请核对：如果确实需要修改，立即真正执行——先用 read_file 确认目标文件当前内容，再用 edit_file 或 write_file 实际写入；在写入成功前不要再说"已修改""已完成"。如果你判断该文件本就无需改动，也不要说"已修改"，而要明确告诉用户"无需修改"以及具体原因。'
              )
            })
            continue
          }

          // 空响应兜底：模型/中转本轮既没输出任何文字，也没发起工具调用（常见于中转服务
          // 偶发返回空流、或模型端异常）。过去这里直接 push 空消息并 break，表现为
          // "发消息没反应、转圈后自动结束、一个字都没有"。现在改为：回收可能变坏的连接后
          // 自动重试若干次；仍为空则明确报错，而不是静默假装完成。
          // 触发条件为「正文为空」即可，不再要求思考也为空：
          // Kimi 等推理模型会出现「只吐 reasoning_content、正文 content 为空、且无工具调用」的
          // 提前收尾（表现为思考好久后自动停止）。这类轮次若被当作有效回复存进历史，会写入一条
          // content 为空的 assistant 消息，导致后续请求 400（must not be empty）。这里改为重试。
          if (
            roundText.trim().length === 0 &&
            !signal.aborted
          ) {
            if (emptyResponseRetryCount < MAX_EMPTY_RESPONSE_RETRIES) {
              emptyResponseRetryCount++
              recycleOutboundDispatcher()
              recordDebugEvent({
                kind: 'request_error',
                sessionId: payload.sessionId || 'default',
                turnId,
                label: 'empty_response',
                detail: `模型返回空响应，自动重试 ${emptyResponseRetryCount}/${MAX_EMPTY_RESPONSE_RETRIES}（finishReason=${lastFinishReason ?? 'none'}）`
              })
              await new Promise((r) => setTimeout(r, Math.min(1000 * emptyResponseRetryCount, 3000)))
              if (signal.aborted) { cancelled = true; break }
              continue
            }
            commitPartialIfSideEffected()
            yield {
              type: 'error',
              turnId,
              code: 'provider_server',
              message: '模型连续多次返回空响应（无任何文字或工具调用）。这通常是中转服务或模型端的问题，而非本地程序。可点「重试」，或在设置中更换模型/检查中转服务。',
              retryable: false
            }
            return
          }

          turnMessages.push({ role: 'assistant', content: roundText })
          this.persistTurnCheckpoint(payload.sessionId || 'default', turnId, turnMessages, 'streaming')
          break
        }

        // 一旦模型正常发起了工具调用，说明本轮响应有效，重置空响应重试计数，
        // 避免跨轮误累加导致后续正常轮次被提前判定为"连续空响应"。
        emptyResponseRetryCount = 0

        
        turnMessages.push({
          role: 'assistant',
          content: roundText,
          toolCalls: calls,
          ...(roundThinking ? { reasoningContent: roundThinking } : {})
        })
        this.persistTurnCheckpoint(payload.sessionId || 'default', turnId, turnMessages, 'tool_running')

        
        const startTimes = new Map<string, number>()
        for (const c of calls) {
          startTimes.set(c.id, Date.now())
          // 记录本轮是否真正发起了图像工具调用（直接调用，或经 ExecuteExtraTool 调用）。
          if (c.name === GENERATE_IMAGE_NAME || c.name === EDIT_IMAGE_NAME) {
            imageToolInvokedThisTurn = true
          } else if (c.name === EXECUTE_EXTRA_TOOL_NAME) {
            const target = argsForEvent(c.arguments).name
            if (target === GENERATE_IMAGE_NAME || target === EDIT_IMAGE_NAME) imageToolInvokedThisTurn = true
          }
          yield {
            type: 'tool_call_start',
            turnId,
            callId: c.id,
            name: c.name,
            args: argsForEvent(c.arguments)
          }
        }

        
        const results = new Map<string, ToolResult>()
        const parallelCalls: ToolCallRequest[] = []
        const gatedCalls: ToolCallRequest[] = []
        for (const c of calls) {
          const tool = this.registry.get(c.name)
          const verdict = this.permissionEngine.decide(
            tool,
            parseToolArguments(c.arguments),
            permOpts
          )
          if (verdict === 'allow' && tool?.readOnly && tool?.concurrencySafe && !tool.supportsBackgroundExecution) parallelCalls.push(c)
          else gatedCalls.push(c)
        }

        const parallelResults = yield* runWithLiveToolEvents(executeToolBatch(parallelCalls, this.registry, toolCtx))
        for (const [k, v] of parallelResults) results.set(k, v)

        // 后台并发预热：同一轮里多个「允许 + 只读 + 可后台执行」的调用（如多张 GenerateImage、
        // 多个 GenerateVideo/Audio）在进入串行循环前先全部 start 起跑，使它们真正并行执行。
        // 串行循环命中这些调用时直接 await 已启动的任务，而非现起现等（否则会退化成逐个串行）。
        const prewarmed = new Map<string, ReturnType<typeof startBackgroundTool>>()
        if (gatedCalls.length > 1) {
          for (const c of gatedCalls) {
            const { activeCall, activeTool } = this.resolveActiveCall(c)
            if (!activeTool?.supportsBackgroundExecution || !activeTool.readOnly) continue
            const verdict = this.permissionEngine.decide(
              activeTool,
              parseToolArguments(activeCall.arguments),
              permOpts
            )
            if (verdict !== 'allow') continue
            prewarmed.set(c.id, startBackgroundTool({
              sessionId: payload.sessionId || 'default',
              turnId,
              call: activeCall,
              ctx: toolCtx,
              run: (deferredCtx) => this.runSingle(activeCall, deferredCtx)
            }))
          }
        }

        for (const c of gatedCalls) {
          const tool = this.registry.get(c.name)
          let activeCall = c
          let activeTool = tool
          if (c.name === EXECUTE_EXTRA_TOOL_NAME) {
            const args = argsForEvent(c.arguments)
            const targetName = typeof args.name === 'string' ? args.name : undefined
            const targetArgs = args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments)
              ? args.arguments
              : {}
            if (targetName && this.registry.isDeferredToolDiscovered(targetName)) {
              const targetTool = this.registry.get(targetName)
              if (targetTool) {
                activeTool = targetTool
                activeCall = { id: c.id, name: targetName, arguments: JSON.stringify(targetArgs) }
              }
            }
          }

          if (activeCall.name === ASK_USER_QUESTION_NAME) {
            const parsed = askUserQuestionSchema.safeParse(parseToolArguments(activeCall.arguments))
            if (!parsed.success) {
              results.set(c.id, { content: '参数无效：AskUserQuestion.questions 必须包含 1-4 个结构化问题', isError: true })
              continue
            }
            const requestId = randomUUID()
            yield {
              type: 'user_question',
              turnId,
              requestId,
              question: parsed.data.questions.map((q) => q.question).join('\n'),
              structuredQuestions: parsed.data.questions
            }
            const response = await this.userQuestionBroker.wait(requestId, signal)
            yield {
              type: 'user_question_resolved',
              turnId,
              requestId,
              answer: response.answer,
              answers: response.answers,
              annotations: response.annotations,
              cancelled: response.cancelled
            }
            const answers = response.answers ?? {}
            const questionAnnotations = response.annotations ?? {}
            const answersText = Object.entries(answers)
              .map(([questionText, answer]) => {
                const note = questionAnnotations[questionText]?.notes?.trim()
                return note
                  ? `"${questionText}"="${answer}"（备注：${note}）`
                  : `"${questionText}"="${answer}"`
              })
              .join(', ')
            results.set(c.id, {
              content: response.cancelled
                ? '用户取消了回答（user_question_cancelled）'
                : `User has answered your questions: ${answersText || response.answer}. You can now continue with the user's answers in mind.`,
              isError: response.cancelled
            })
            continue
          }

          if (activeCall.name === ASK_USER_NAME) {
            const parsed = askUserSchema.safeParse(parseToolArguments(activeCall.arguments))
            if (!parsed.success) {
              results.set(c.id, { content: '参数无效：ask_user.question 不能为空', isError: true })
              continue
            }
            const requestId = randomUUID()
            yield {
              type: 'user_question',
              turnId,
              requestId,
              question: parsed.data.question,
              suggestions: parsed.data.suggestions
            }
            const response = await this.userQuestionBroker.wait(requestId, signal)
            yield {
              type: 'user_question_resolved',
              turnId,
              requestId,
              answer: response.answer,
              cancelled: response.cancelled
            }
            results.set(c.id, {
              content: response.cancelled
                ? '用户取消了回答（user_question_cancelled）'
                : `用户回答：${response.answer}`,
              isError: response.cancelled
            })
            continue
          }

          
          if (this.hookRunner.hasAny('PreToolUse', activeCall.name)) {
            const preResult = await this.hookRunner.dispatch(
              'PreToolUse',
              {
                ...hookBase,
                hook_event_name: 'PreToolUse',
                tool_name: activeCall.name,
                tool_input: parseToolArguments(activeCall.arguments)
              } as HookInput,
              activeCall.name,
              signal
            )
            if (preResult.updatedInput) {
              activeCall = { ...activeCall, arguments: JSON.stringify(preResult.updatedInput) }
            }
            if (preResult.blocked || preResult.permissionDecision === 'deny') {
              denials.recordDenial()
              const reason = preResult.blockReason || 'PreToolUse hook 拒绝了该操作'
              results.set(c.id, {
                content: `操作被 hook 阻止（blocked_by_hook）：${reason}`,
                isError: true
              })
              continue
            }
            for (const ctxText of preResult.additionalContext) {
              turnMessages.push({ role: 'user', content: systemReminder(ctxText) })
            }
          }

          
          if (activeTool?.producesFileChange) {
            const proposal = yield* runWithLiveToolEvents(this.runSingle(activeCall, toolCtx))
            if (proposal.isError || !proposal.fileChange) {
              results.set(c.id, proposal)
              continue
            }
            const fc = proposal.fileChange
            const changeId = randomUUID()
            yield { type: 'file_change_proposed', turnId, changeId, callId: c.id, path: fc.path, diff: fc.diff }

            const writeVerdict = this.permissionEngine.decide(
              activeTool,
              parseToolArguments(activeCall.arguments),
              permOpts
            )
            let allowed = writeVerdict === 'allow'
            if (!allowed) {
              const fcDecision = await this.fileChangeBroker.wait(changeId, signal)
              allowed = fcDecision === 'accept'
            } else if (acceptEdits && behavior.acceptEditsAutoApplyDelayMs > 0) {
              const fcDecision = await this.fileChangeBroker.waitAutoAccept(
                changeId,
                behavior.acceptEditsAutoApplyDelayMs,
                signal
              )
              allowed = fcDecision === 'accept'
            }

            if (!allowed) {
              yield { type: 'file_change_rejected', turnId, path: fc.path }
              results.set(c.id, {
                content: acceptEdits
                  ? '修改已取消（用户撤销或停止）'
                  : `用户拒绝了该修改（rejected_by_user）\n\n${permissionDeniedReminder(activeCall.name)}`,
                isError: true
              })
              if (!acceptEdits) denials.recordDenial()
              continue
            }

            
            if (isDirty(fc.path)) {
              yield { type: 'file_change_rejected', turnId, path: fc.path }
              results.set(c.id, {
                content: `目标文件有未保存改动，已拒绝写入（dirty_conflict）\n\n${dirtyConflictReminder(fc.path)}`,
                isError: true
              })
              continue
            }

            try {
              await this.checkpoint.snapshot(fc.path)
              await this.fileChangeHistory.captureBeforeWrite(changeId, fc.path, fc.encoding, fc.newContent)
              await writeTextFile(fc.path, fc.newContent, fc.encoding)
              noteAgentWrite(fc.path)
              sideEffected = true
              fileChangeAppliedThisTurn = true
              yield { type: 'file_change_applied', turnId, changeId, path: fc.path }
              results.set(c.id, { content: `已${fc.isCreate ? '创建' : '修改'}：${fc.path}` })
              denials.recordSuccess()
              void recordAudit({
                action: fc.isCreate ? 'create' : 'edit',
                tool: activeCall.name,
                sessionId: payload.sessionId || 'default',
                turnId,
                path: fc.path
              })
            } catch (e) {
              results.set(c.id, {
                content: e instanceof Error ? e.message : '写入失败',
                isError: true
              })
            }
            continue
          }

          let verdict = this.permissionEngine.decide(
            activeTool,
            parseToolArguments(activeCall.arguments),
            permOpts
          )
          if (verdict === 'ask') {
            const requestId = randomUUID()
            yield {
              type: 'permission_request',
              turnId,
              requestId,
              tool: activeCall.name,
              summary: permissionSummary(activeCall),
              details: permissionDetails(activeCall)
            }
            const decision = await this.broker.wait(requestId, signal)
            const allowed = decision !== 'deny'
            yield { type: 'permission_resolved', turnId, requestId, decision: allowed ? 'allow' : 'deny' }
            if (decision === 'allow_session' && activeTool) {
              this.permissionEngine.grantSession(activeTool.name)
              
              if (activeTool.permissionGroup) {
                this.permissionEngine.grantSessionGroup(activeTool.permissionGroup)
              }
            }
            if (decision === 'allow_project' && activeTool && effectiveWorkspaceRoot) {
              addProjectPermissionAllow(effectiveWorkspaceRoot, activeTool.name)
              if (activeTool.permissionGroup) {
                addProjectPermissionAllow(effectiveWorkspaceRoot, activeTool.permissionGroup)
              }
              this.permissionEngine.loadRules(effectiveWorkspaceRoot)
            }
            verdict = allowed ? 'allow' : 'deny'
          }

          if (verdict === 'deny') {
            results.set(c.id, {
              content: `操作被拒绝（permission_denied）\n\n${permissionDeniedReminder(activeCall.name)}`,
              isError: true
            })
            denials.recordDenial()
          } else {
            denials.recordSuccess()
            let res: ToolResult
            if (activeTool?.supportsBackgroundExecution) {
              const record = prewarmed.get(c.id) ?? startBackgroundTool({
                sessionId: payload.sessionId || 'default',
                turnId,
                call: activeCall,
                ctx: toolCtx,
                run: (deferredCtx) => this.runSingle(activeCall, deferredCtx)
              })
              yield {
                type: 'tool_call_result',
                turnId,
                callId: c.id,
                result: `Background tool execution started. backgroundId: ${record.id}`,
                deferred: true,
                backgroundId: record.id,
                deferredId: record.id,
                status: 'pending'
              }
              res = yield* runWithLiveToolEvents(awaitBackgroundTool(record.id))
            } else {
              res = yield* runWithLiveToolEvents(this.runSingle(activeCall, toolCtx))
            }
            results.set(c.id, res)
            
            if (res.appliedPath && !res.isError) {
              sideEffected = true
              yield { type: 'file_change_applied', turnId, path: res.appliedPath }
              void recordAudit({
                action: 'delete',
                tool: activeCall.name,
                sessionId: payload.sessionId || 'default',
                turnId,
                path: res.appliedPath
              })
            }
            
            if (activeCall.name === 'run_terminal_cmd' || activeCall.name === 'PowerShell' || activeCall.name === 'StartTerminalTask') {
              const cmdArgs = argsForEvent(activeCall.arguments)
              void recordAudit({
                action: 'terminal',
                tool: activeCall.name,
                sessionId: payload.sessionId || 'default',
                turnId,
                command: typeof cmdArgs.command === 'string' ? cmdArgs.command : undefined
              })
            }
          }
        }

        
        
        const budgetedResults = externalizeToolResultsWithState(calls, results, turnContentReplacementState)
        for (const c of calls) {
          while (pendingToolEvents.length > 0) {
            const event = pendingToolEvents.shift()
            if (event) yield event
          }
          const r = budgetedResults.get(c.id) ?? { content: '(无结果)' }
          const started = startTimes.get(c.id)
          const durationMs = started !== undefined ? Date.now() - started : undefined
          yield {
            type: 'tool_call_result',
            turnId,
            callId: c.id,
            result: r.content,
            truncated: r.truncated,
            isError: r.isError,
            durationMs,
            deferred: r.deferred,
            backgroundId: r.backgroundId,
            deferredId: r.deferredId,
            status: r.isError ? 'error' : 'completed'
          }
          const toolContent = r.truncated
            ? `${r.content}\n\n${truncatedOutputReminder()}`
            : r.content
          const toolMsg: ChatMessage = { role: 'tool', toolCallId: c.id, content: toolContent }
          // 工具产出的图片仅在模型支持视觉时附带，否则保留文本占位。
          if (profile.supportsVision && r.images?.length) {
            toolMsg.images = r.images
          }
          turnMessages.push(toolMsg)
          this.persistTurnCheckpoint(payload.sessionId || 'default', turnId, turnMessages, 'tool_running')
        }

        if (denials.shouldTerminate()) {
          commitPartialIfSideEffected()
          yield {
            type: 'error',
            turnId,
            code: 'denial_limit',
            message: denialLimitMessage(),
            retryable: false
          }
          return
        }

        steps += calls.length
        if (maxToolSteps > 0 && steps >= maxToolSteps) {
          commitPartialIfSideEffected()
          yield {
            type: 'error',
            turnId,
            code: 'turn_limit',
            message: `已达单轮最大工具步数（${maxToolSteps}），已停止。`,
            retryable: false
          }
          return
        }

        if (signal.aborted) {
          cancelled = true
          break
        }
      }
    } finally {
      this.active = null
      
      this.checkpoint.finalizeTurn()
    }

    
    // 历史添加完成后、turn_end 之前：检测任务完成并插入记笔记提醒
    // reconcileOrphanToolCalls：取消发生在工具执行阶段时，turnMessages 里可能有
    // 「有 tool_use、无 tool_result」的孤儿调用，补齐占位结果后再入历史，
    // 保证下一轮请求的消息序列合规（尤其是 Anthropic 的严格配对校验）。
    this.historyTurns.push({ turnId, messages: reconcileOrphanToolCalls(turnMessages) })
    if (!contentReplacementCommitted) commitContentReplacementState()

    const memSettings = getMemorySettings()
    if (memSettings.enabled && memSettings.autoNoteReminder && !cancelled) {
      const allToolCalls = turnMessages.flatMap((m) =>
        m.role === 'assistant' && m.toolCalls?.length ? m.toolCalls : []
      )
      const finalText = turnMessages
        .filter((m) => m.role === 'assistant')
        .map((m) => (typeof m.content === 'string' ? m.content : ''))
        .join('')
      const completionSignal = detectTaskCompletion({
        turnMessages,
        toolCalls: allToolCalls,
        finalText
      })
      if (completionSignal.shouldRemind) {
        const reminderText = buildNoteReminder(turnId)
        this.historyTurns.push({
          turnId: `${turnId}-note-reminder`,
          messages: [{ role: 'user', content: systemReminder(reminderText) }]
        })
        recordDebugEvent({
          kind: 'memory',
          sessionId: payload.sessionId || 'default',
          turnId,
          label: 'note-reminder',
          detail: completionSignal.reason ?? 'complex task completed'
        })
      }

      // 方案 A：回合结束反思提取。仅在"含个人信息/偏好/承诺"或任务完成的回合触发，
      // 砍掉纯操作/寒暄回合的无谓 LLM 调用。fire-and-forget，独立调用不污染 promptCache，失败静默。
      const reflectSessionId = payload.sessionId || 'default'
      const worthy = isMemoryWorthyTurn({ turnMessages, completion: completionSignal })
      if (reflectSessionId !== 'default' && worthy) {
        const reflectMsgs = turnMessages.filter(
          (m) => (m.role === 'user' || m.role === 'assistant') && (m.content ?? '').trim()
        )
        if (reflectMsgs.length > 0) {
          const memRoot = this.lastMemoryRoot
          const activeFile = payload.editorContext?.activeFilePath
          // 不在回合末尾立即跑反思（会额外发一次 LLM 请求，与后续主对话抢 Provider 资源，
          // 造成"记笔记后卡 ~10 秒"）。登记为空闲任务：会话安静 IDLE_REFLECT_DELAY_MS 后才执行；
          // 若期间用户又发消息（新 turn），submitTurn 会取消它，顺延到下次空闲。
          this.scheduleIdleReflect(() => {
            void import('../memory/reflection')
              .then(({ reflectAndEncode }) =>
                reflectAndEncode({
                  sessionId: reflectSessionId,
                  messages: reflectMsgs,
                  workspaceRoot: memRoot,
                  activeFile
                })
              )
              .catch(() => {})
          })
        }
      }
    }

    if (cancelled) {
      yield { type: 'warning', turnId, message: '已停止生成' }
    }
    const estimatedPromptTokens = countChatMessagesTokens(
      [{ role: 'system', content: systemText }, ...this.flattenModelHistory()],
      profile.model,
      profile.kind
    )
    let estimatedOutputTokens = 0
    for (const m of turnMessages) {
      if (m.role === 'assistant' && m.content) {
        estimatedOutputTokens += countTokens(m.content, profile.model, profile.kind)
      }
    }
    const apiInputTokens = usage?.apiInputTokens ?? usage?.inputTokens ?? 0
    const apiOutputTokens = usage?.apiOutputTokens ?? usage?.outputTokens ?? 0
    const cacheReadInputTokens = usage?.cacheReadInputTokens
    const cacheCreationInputTokens = usage?.cacheCreationInputTokens
    const hasApiUsage = apiInputTokens > 0 || apiOutputTokens > 0 || cacheReadInputTokens !== undefined || cacheCreationInputTokens !== undefined
    const likelyBrokenPromptCache = Boolean(
      usage?.promptCacheHitRate !== undefined &&
      this.lastPromptCacheSnapshot?.signature === promptCacheSignature &&
      this.lastPromptCacheSnapshot.hitRate >= 10 &&
      (cacheReadInputTokens ?? 0) === 0 &&
      (cacheCreationInputTokens ?? 0) > 0
    )
    const promptCacheStatus = hasApiUsage
      ? computePromptCacheStatus({ cacheReadInputTokens, cacheCreationInputTokens }, likelyBrokenPromptCache)
      : undefined
    const promptCacheProvider = hasApiUsage
      ? profile.kind === 'anthropic'
        ? 'anthropic' as const
        : profile.kind === 'deepseek'
          ? 'deepseek' as const
          : 'openai' as const
      : undefined
    const promptCacheStrategy = hasApiUsage
      ? profile.kind === 'anthropic'
        ? 'anthropic_cache_control' as const
        : profile.kind === 'deepseek'
          ? 'deepseek_disk_cache' as const
          : 'openai_prompt_cache_key' as const
      : undefined
    const displayedInputTokens = hasApiUsage
      ? apiInputTokens + (cacheReadInputTokens ?? 0) + (cacheCreationInputTokens ?? 0)
      : estimatedPromptTokens

    let contextBreakdown
    try {
      const priorHistory = this.visibleHistoryTurns().slice(0, -1).flatMap((t) => t.messages)
      contextBreakdown = await buildContextBreakdown({
        ctx,
        toolDefs: currentToolDefs,
        history: priorHistory,
        fullUserContent: userMsg.content,
        rawUserMessage: payload.message,
        model: profile.model,
        kind: profile.kind,
        contextWindow
      })
    } catch {
      contextBreakdown = undefined
    }

    const existingSession = loadSession(payload.sessionId || 'default')
    if (existingSession) {
      try {
        saveSession({
          ...existingSession,
          updatedAt: Date.now(),
          history: this.exportHistoryMessages(),
          replacementRecords: this.exportContentReplacementRecords(),
          discoveredDeferredTools: this.exportDiscoveredDeferredTools(),
          fileChanges: this.exportFileChanges(),
          inProgress: null
        })
      } catch {
        
      }
    }

    yield {
      type: 'turn_end',
      turnId,
      usage: {
        inputTokens: displayedInputTokens,
        outputTokens: hasApiUsage ? apiOutputTokens : estimatedOutputTokens,
        apiInputTokens: hasApiUsage ? apiInputTokens : undefined,
        apiOutputTokens: hasApiUsage ? apiOutputTokens : undefined,
        cacheReadInputTokens,
        cacheCreationInputTokens,
        promptCacheHitRate: usage?.promptCacheHitRate,
        promptCacheStatus,
        promptCacheProvider,
        promptCacheStrategy,
        promptCacheLikelyBroken: likelyBrokenPromptCache || undefined,
        estimatedPromptTokens,
        estimatedOutputTokens,
        contextBreakdown
      }
    }

    if (usage?.promptCacheHitRate !== undefined) {
      this.lastPromptCacheSnapshot = { signature: promptCacheSignature, hitRate: usage.promptCacheHitRate }
    }

    recordDebugEvent({
      kind: 'request_end',
      sessionId: payload.sessionId || 'default',
      turnId,
      label: profile.model,
      detail: `${cancelled ? 'cancelled, ' : ''}steps=${steps}, in=${displayedInputTokens}, out=${hasApiUsage ? apiOutputTokens : estimatedOutputTokens}${usage?.promptCacheHitRate !== undefined ? `, cacheHit=${usage.promptCacheHitRate}%` : ''}${promptCacheStatus ? `, cache=${promptCacheStatus}` : ''}`,
      durationMs: Date.now() - started
    })

    appendUsageLog({
      ts: Date.now(),
      profileId: profile.id,
      model: profile.model,
      kind: profile.kind,
      inputTokens: displayedInputTokens,
      outputTokens: hasApiUsage ? apiOutputTokens : estimatedOutputTokens,
      apiInputTokens: hasApiUsage ? apiInputTokens : undefined,
      apiOutputTokens: hasApiUsage ? apiOutputTokens : undefined,
      cacheReadInputTokens,
      cacheCreationInputTokens,
      sessionId: payload.sessionId || 'default',
      turnId
    })
  }
}

function toErrorEvent(turnId: string, e: unknown): AgentEvent {
  if (e instanceof ProviderError) {
    recordDebugEvent({
      kind: 'request_error',
      turnId,
      label: e.code,
      detail: e.message
    })
    return {
      type: 'error',
      turnId,
      code: e.code,
      message: e.message,
      httpStatus: e.httpStatus,
      retryable: e.retryable
    }
  }
  recordDebugEvent({
    kind: 'request_error',
    turnId,
    label: 'unknown',
    detail: e instanceof Error ? e.message : String(e)
  })
  return {
    type: 'error',
    turnId,
    code: 'unknown',
    message: e instanceof Error ? e.message : '未知错误',
    retryable: false
  }
}


const engines = new Map<string, QueryEngine>()


export function getQueryEngine(sessionId = 'default'): QueryEngine {
  let e = engines.get(sessionId)
  if (!e) {
    e = new QueryEngine()
    engines.set(sessionId, e)
  }
  return e
}


export function getExistingQueryEngine(sessionId = 'default'): QueryEngine | undefined {
  return engines.get(sessionId)
}


export async function disposeQueryEngine(sessionId: string): Promise<void> {
  const e = engines.get(sessionId)
  if (e) {
    e.cancel()
    e.clear(sessionId)
  }
  resetTasks(sessionId)
  
  await closeBrowserSessionsForAgent(sessionId)
  closeDesktopSessionsForAgent(sessionId)
  engines.delete(sessionId)
}


export function listQueryEngineSessionIds(): string[] {
  return [...engines.keys()]
}
