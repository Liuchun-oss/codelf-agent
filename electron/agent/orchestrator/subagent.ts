import { randomUUID } from 'crypto'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { app } from 'electron'
import { z } from 'zod'
import { APP_NAME, DATA_DIR_NAME } from '@shared/appConfig'
import type { AgentEvent, ContentReplacementRecord, SubagentTaskSummary, TokenUsage } from '@shared/agentTypes'
import { createAdapter, ProviderError, type ChatMessage, type ToolDef, type ToolCallRequest } from '../providers'
import { getActiveProfileApiKey, getActiveProfileId, getProfileRaw, getProfileApiKey, resolveProfileByIdOrName } from '../providers/profileStore'
import { fetchSystemPromptPartsAsync, assembleSystemMessage, fetchDynamicContextBlock } from '../prompts/assembler'
import type { PromptContext } from '../prompts/types'
import { countChatMessagesTokens, countTokens } from '../context/tokenCounter'
import { buildDefaultRegistry, ToolRegistry } from '../tools/registry'
import type { Tool, ToolContext, ToolResult } from '../tools/types'
import { ToolCallAccumulator, executeToolBatch, parseToolArguments } from '../tools/streamingExecutor'
import { PermissionEngine } from '../permissions/engine'
import { writeTextFile } from '../../services/fsService'
import { noteAgentWrite } from '../../services/localWriteRegistry'
import { isPathDirty } from '../../services/editorSnapshot'
import {
  cloneContentReplacementState,
  createContentReplacementState,
  createContentReplacementStateFromRecords,
  exportContentReplacementRecords,
  externalizeToolResultsWithState,
  type ContentReplacementState
} from '../tools/resultStorage'
import { currentShellName } from '../../services/headlessTerminal'
import { getAgentDefinition, listAgentDefinitions, summarizeAgentDefinition, type AgentDefinition } from './agentDefinitions'

export const RUN_SUBAGENT_NAME = 'run_subagent'

const DEFAULT_RESPONSE_LANGUAGE = 'Simplified Chinese'
const MAX_FORK_CONTEXT_CHARS = 12_000
const SUBAGENT_WORKTREE_DIR = 'subagent-worktrees'

interface SubagentTranscriptRecord {
  id: string
  input: RunSubagentInput
  messages: ChatMessage[]
  status: 'running' | 'completed' | 'error' | 'cancelled'
  finalText?: string
  usage?: TokenUsage
  durationMs?: number
  failureSummary?: string
  parentSessionId?: string
  replacementRecords?: ContentReplacementRecord[]
  updatedAt: number
}

type SubagentEventSink = (event: AgentEvent) => void

const subagentTranscripts = new Map<string, SubagentTranscriptRecord>()
const subagentEventSinks = new Map<string, SubagentEventSink>()
const backgroundSubagentControllers = new Map<string, AbortController>()

function userDataPath(): string | null {
  try {
    return app.getPath('userData')
  } catch {
    return null
  }
}

function subagentsDir(): string | null {
  const base = userDataPath()
  if (!base) return null
  try {
    const dir = join(base, 'subagents')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return dir
  } catch {
    return null
  }
}

function isSafeSubagentId(id: string): boolean {
  return /^subagent-[A-Za-z0-9_-]{1,160}$/.test(id)
}

function subagentFile(id: string): string | null {
  const dir = subagentsDir()
  return dir ? join(dir, `${id}.json`) : null
}

function saveSubagentTranscript(record: SubagentTranscriptRecord): void {
  if (!isSafeSubagentId(record.id)) return
  subagentTranscripts.set(record.id, record)
  const file = subagentFile(record.id)
  if (!file) return
  try {
    const tmp = `${file}.${randomUUID()}.tmp`
    writeFileSync(tmp, JSON.stringify({ v: 1, ...record }, null, 2), 'utf-8')
    renameSync(tmp, file)
  } catch {
    
  }
}

function isSubagentStatus(value: unknown): value is SubagentTranscriptRecord['status'] {
  return value === 'running' || value === 'completed' || value === 'error' || value === 'cancelled'
}

function loadSubagentTranscript(id: string): SubagentTranscriptRecord | undefined {
  const cached = subagentTranscripts.get(id)
  if (cached) return cached
  if (!isSafeSubagentId(id)) return undefined
  const file = subagentFile(id)
  if (!file || !existsSync(file)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<SubagentTranscriptRecord>
    if (!parsed.id || !Array.isArray(parsed.messages) || !parsed.input || !isSubagentStatus(parsed.status)) return undefined
    const record: SubagentTranscriptRecord = {
      id: parsed.id,
      input: parsed.input,
      messages: parsed.messages,
      status: parsed.status,
      finalText: parsed.finalText,
      usage: parsed.usage,
      durationMs: parsed.durationMs,
      failureSummary: parsed.failureSummary,
      parentSessionId: parsed.parentSessionId,
      replacementRecords: Array.isArray(parsed.replacementRecords)
        ? parsed.replacementRecords.filter((r): r is ContentReplacementRecord =>
            !!r && r.kind === 'tool-result' && typeof r.toolUseId === 'string'
          )
        : undefined,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now()
    }
    subagentTranscripts.set(id, record)
    return record
  } catch {
    return undefined
  }
}

export function setSubagentEventSink(sessionId: string, sink: SubagentEventSink | null): void {
  if (!sessionId) return
  if (sink) subagentEventSinks.set(sessionId, sink)
  else subagentEventSinks.delete(sessionId)
}

export function clearAllSubagentEventSinks(): void {
  subagentEventSinks.clear()
}

function emitBackgroundSubagentEvent(sessionId: string | undefined, event: AgentEvent): void {
  if (!sessionId) return
  subagentEventSinks.get(sessionId)?.(event)
}

function toSubagentTaskSummary(record: SubagentTranscriptRecord): SubagentTaskSummary {
  return {
    id: record.id,
    description: record.input.description,
    subagentType: record.input.subagentType,
    status: record.status,
    parentSessionId: record.parentSessionId,
    finalText: record.finalText,
    failureSummary: record.failureSummary,
    durationMs: record.durationMs,
    updatedAt: record.updatedAt,
    model: resolveSubagentModelLabel(record.input.model)
  }
}

export function listSubagentTasks(sessionId?: string): SubagentTaskSummary[] {
  const records = new Map<string, SubagentTranscriptRecord>(subagentTranscripts)
  const dir = subagentsDir()
  if (dir) {
    try {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.json')) continue
        const id = file.slice(0, -'.json'.length)
        const record = loadSubagentTranscript(id)
        if (record) records.set(record.id, record)
      }
    } catch {
      
    }
  }
  return [...records.values()]
    .filter((record) => !sessionId || record.parentSessionId === sessionId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(toSubagentTaskSummary)
}

export function cancelSubagentTask(subagentId: string): boolean {
  const record = loadSubagentTranscript(subagentId)
  if (!record || record.status !== 'running') return false
  backgroundSubagentControllers.get(subagentId)?.abort()
  backgroundSubagentControllers.delete(subagentId)
  saveSubagentTranscript({
    ...record,
    status: 'cancelled',
    failureSummary: '用户取消了后台子 Agent。',
    updatedAt: Date.now()
  })
  emitBackgroundSubagentEvent(record.parentSessionId, {
    type: 'subagent_end',
    turnId: subagentId,
    subagentId,
    callId: subagentId,
    status: 'error',
    finalText: '后台子 Agent 已取消。',
    failureSummary: '用户取消了后台子 Agent。'
  })
  return true
}

export function listAvailableSubagentDefinitions(workspaceRoot?: string | null) {
  return listAgentDefinitions(workspaceRoot).map(summarizeAgentDefinition)
}

function worktreesDir(): string {
  const base = userDataPath() ?? tmpdir()
  const dir = join(base, SUBAGENT_WORKTREE_DIR)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

interface IsolatedWorktreeHandle {
  path: string
  cleanup: () => void
}

function createIsolatedWorktree(workspaceRoot: string | null, subagentId: string): IsolatedWorktreeHandle | { error: string } {
  if (!workspaceRoot) return { error: 'isolatedWorktree 需要已打开的工作区。' }
  try {
    execFileSync('git', ['-C', workspaceRoot, 'rev-parse', '--show-toplevel'], { encoding: 'utf-8', stdio: 'pipe' })
  } catch {
    return { error: 'isolatedWorktree 需要当前工作区是 Git 仓库。' }
  }

  const path = join(worktreesDir(), subagentId)
  try {
    rmSync(path, { recursive: true, force: true })
    execFileSync('git', ['-C', workspaceRoot, 'worktree', 'add', '--detach', path, 'HEAD'], {
      encoding: 'utf-8',
      stdio: 'pipe'
    })
  } catch (e) {
    rmSync(path, { recursive: true, force: true })
    return { error: e instanceof Error ? e.message : '创建 isolated worktree 失败。' }
  }

  return {
    path,
    cleanup: () => {
      try {
        execFileSync('git', ['-C', workspaceRoot, 'worktree', 'remove', '--force', path], {
          encoding: 'utf-8',
          stdio: 'pipe'
        })
      } catch {
        rmSync(path, { recursive: true, force: true })
      }
    }
  }
}

export const runSubagentSchema = z.object({
  description: z
    .string()
    .min(1)
    .max(120)
    .describe('A short, user-visible description of what the sub-agent will do.'),
  task: z
    .string()
    .min(1)
    .max(8000)
    .describe('The complete task for the sub-agent, including all context it needs.'),
  subagentType: z
    .string()
    .max(80)
    .optional()
    .describe(`The kind of sub-agent to run. Defaults to readonly. Project agents from ${DATA_DIR_NAME}/agents/*.md are supported.`),
  model: z
    .string()
    .max(120)
    .optional()
    .describe('Optional model/provider for this sub-agent. Accepts a configured provider profile id, name, or model name (fuzzy match). Defaults to the parent agent\'s active model when omitted or unresolved.'),
  expectedOutput: z
    .string()
    .max(1000)
    .optional()
    .describe('Optional instructions for the shape of the sub-agent final report.'),
  runInBackground: z
    .boolean()
    .optional()
    .describe('If true, start the sub-agent asynchronously and return immediately with its id.'),
  resumeSubagentId: z
    .string()
    .optional()
    .describe('Resume a previously started background sub-agent by id, appending task as a follow-up.'),
  inputsFromSubagentIds: z
    .array(z.string())
    .max(10)
    .optional()
    .describe('Ids of previously completed sub-agents whose final reports should be injected as input/context for this sub-agent. Use this for staged handoff: reference an earlier peer by id instead of copying its output into task.'),
  forkContext: z
    .boolean()
    .optional()
    .describe('If true, include a compact snapshot of the parent conversation context in the sub-agent prompt.'),
  isolatedWorktree: z
    .boolean()
    .optional()
    .describe('If true, run the sub-agent against a detached temporary Git worktree and clean it up afterwards.')
})

export type RunSubagentInput = z.infer<typeof runSubagentSchema>

const RUN_SUBAGENT_DESCRIPTION = [
  'Launch a new sub-agent to handle complex, multi-step tasks autonomously.',
  'Use this when work benefits from delegation: broad codebase exploration, independent research, review, validation, or a well-scoped implementation/analysis task supported by the selected subagentType.',
  'Do NOT use this when you only need to read a specific file, search for a specific string/class, or inspect 2-3 known files; use read_file, Glob, grep, or codebase_search instead.',
  'Always include a short user-visible description and a complete task. Each sub-agent starts without the parent conversation unless forkContext is true, so brief it like a smart colleague who has not seen this chat: include goal, context, relevant files, constraints, what you already know, and expected output.',
  `Use subagentType to select readonly, explore, reviewer, general-purpose, implementer, planner, or a project agent from ${DATA_DIR_NAME}/agents/*.md. The default is readonly. Only implementer (or a project agent with readOnly:false) can write files or run commands, and only while the user has auto-approval (Accept Edits) on; otherwise its writes are denied since a sub-agent cannot prompt for approval.`,
  'Use model to run this sub-agent on a different configured provider/model than the parent: pass a provider profile id, name, or model name (fuzzy matched against the user\'s configured models). This lets you delegate cheap/bulk work to a smaller model and reserve a stronger model for hard subtasks. If omitted or it cannot be resolved, the sub-agent inherits the parent\'s active model.',
  'Use runInBackground to start it asynchronously and return immediately with a subagent id when you have independent work to continue. Do not assume or fabricate background results before completion.',
  'CRITICAL for runInBackground: this call returns ONLY a started confirmation, NOT the result. You will NOT receive the result later in this same turn. Do NOT use Sleep, polling, or repeated checks to wait for a background sub-agent — that wastes turns and leads to false "stuck" conclusions. After starting a background sub-agent, either continue with other independent work or end your turn; the user is notified when it finishes and can hand the result back to you. If you actually need the result before continuing, run the sub-agent in the FOREGROUND instead (omit runInBackground); multiple foreground sub-agents in one turn run in parallel.',
  'When a task naturally splits into several independent sub-tasks, prefer fanning out: emit several run_subagent calls in the SAME turn, each with its own focused task, and they will execute in parallel (up to the configured parallel limit; any extra are batched automatically). Give each one a distinct description and a self-contained task so they do not overlap.',
  'Use resumeSubagentId to continue a previously started background sub-agent with a follow-up task.',
  'Use forkContext when the child needs a compact snapshot of the parent conversation context.',
  'Use inputsFromSubagentIds for staged handoff: pass the ids of earlier completed sub-agents and their final reports are injected as input for this one, so you can chain peers (research -> implement -> review) without copying long outputs into task. Run peers in the foreground, inspect each result, then launch the next stage referencing the prior id.',
  'Use isolatedWorktree to run against a detached temporary Git worktree; failure is reported instead of silently falling back.',
  'The sub-agent cannot spawn another sub-agent. Its outputs should generally be trusted, but summarize or act on them only after you receive the result.'
].join(' ')

export const runSubagentToolDef: ToolDef = {
  name: RUN_SUBAGENT_NAME,
  description: RUN_SUBAGENT_DESCRIPTION,
  parameters: (() => {
    const json = z.toJSONSchema(runSubagentSchema) as Record<string, unknown>
    delete json.$schema
    return json
  })()
}

export interface SubagentRunSummary {
  usage?: {
    inputTokens: number
    outputTokens: number
  }
  durationMs?: number
  failureSummary?: string
}

export function formatSubagentResult(
  input: RunSubagentInput,
  finalText: string,
  summary: SubagentRunSummary = {}
): string {
  const header = `Sub-agent completed: ${input.description}`
  const body = finalText.trim() || '(sub-agent returned no final text)'
  const meta: string[] = []
  if (typeof summary.durationMs === 'number') meta.push(`Duration: ${summary.durationMs}ms`)
  if (summary.usage) meta.push(`Tokens: ${summary.usage.inputTokens} input / ${summary.usage.outputTokens} output`)
  if (summary.failureSummary) meta.push(`Failure summary: ${summary.failureSummary}`)
  return meta.length ? `${header}\n${meta.join('\n')}\n\n${body}` : `${header}\n\n${body}`
}

function todayISODate(): string {
  return new Date().toISOString().slice(0, 10)
}

function subagentRegistry(definition: AgentDefinition): ToolRegistry {
  const registry = new ToolRegistry()
  const allowed = definition.allowedTools ? new Set(definition.allowedTools.map((name) => name.toLowerCase())) : null
  const denied = new Set(definition.deniedTools.map((name) => name.toLowerCase()))
  for (const tool of buildDefaultRegistry().availableTools()) {
    const toolName = tool.name.toLowerCase()
    if (definition.readOnly && !tool.readOnly) continue
    if (allowed && !allowed.has(toolName)) continue
    if (denied.has(toolName)) continue
    registry.register(tool)
  }
  return registry
}

function makeSubagentPrompt(input: RunSubagentInput, definition: AgentDefinition, forkContext?: string, handoffInputs?: string): string {
  return [
    definition.prompt,
    '',
    `子 Agent 类型：${definition.id}（${definition.title}）`,
    '',
    '硬性规则：',
    definition.readOnly ? '- 只能调查、分析、验证和总结，不要修改文件。' : '- 可写入/执行命令，但仅当用户开启“自动审批”时才会放行；未开启则写操作被拒，且你无法弹框请求。改动后自行运行命令验证，最后列出改了哪些文件。',
    '- 不要再委派子 Agent。',
    '- 优先使用工具获取证据；如果信息不足，明确说明缺口。',
    '- 输出要简洁、结构化，并包含关键文件或证据。',
    forkContext ? `\n父 Agent 上下文快照（fork context）：\n${forkContext}` : '',
    handoffInputs ? `\n前序子 Agent 交接产物（来自上游阶段，作为本次任务的输入）：\n${handoffInputs}` : '',
    '',
    `任务：${input.task}`,
    input.expectedOutput ? `\n期望输出格式：${input.expectedOutput}` : '',
    '',
    '最终回答请直接给出结论，不要添加与任务无关的寒暄。'
  ]
    .filter((part) => part.length > 0)
    .join('\n')
}

function buildForkContext(messages: ChatMessage[] | undefined): string | undefined {
  if (!messages?.length) return undefined
  const lines = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
  const text = lines.join('\n\n')
  return text.length > MAX_FORK_CONTEXT_CHARS
    ? `…（前文已截断）\n${text.slice(-MAX_FORK_CONTEXT_CHARS)}`
    : text
}

function resolveHandoffInputs(ids: string[] | undefined): string | undefined {
  if (!ids?.length) return undefined
  const sections: string[] = []
  for (const id of ids) {
    const record = loadSubagentTranscript(id)
    if (!record) {
      sections.push(`【${id}】未找到该子 Agent 的产物（可能已过期或 id 有误）。`)
      continue
    }
    const label = record.input.description || id
    const body = (record.finalText ?? '').trim() || '(无最终产物)'
    sections.push(`【来自 ${label}（${id}，状态：${record.status}）】\n${body}`)
  }
  if (!sections.length) return undefined
  const text = sections.join('\n\n')
  return text.length > MAX_FORK_CONTEXT_CHARS
    ? `${text.slice(0, MAX_FORK_CONTEXT_CHARS)}\n…（交接产物已截断）`
    : text
}

interface AppliedFileChange {
  path: string
  diff: string
  isCreate: boolean
}

async function executeSubagentToolBatch(
  calls: ToolCallRequest[],
  registry: ToolRegistry,
  ctx: ToolContext,
  permissionEngine: PermissionEngine,
  permissionMode: 'default' | 'acceptEdits',
  fileChanges: Map<string, AppliedFileChange>
): Promise<Map<string, ToolResult>> {
  const gated: ToolCallRequest[] = []
  const denied = new Map<string, ToolResult>()
  for (const call of calls) {
    const tool = registry.get(call.name)
    if (tool && !tool.readOnly) {
      const verdict = permissionEngine.decide(tool, parseToolArguments(call.arguments), {
        permissionMode,
        workspaceRoot: ctx.workspaceRoot
      })
      if (verdict !== 'allow') {
        denied.set(call.id, {
          content:
            '操作被拒绝（permission_denied）：子 Agent 的写入/命令操作需要在输入框开启“自动审批”（acceptEdits）后才能执行。请提示用户开启自动审批，或改用只读方式完成任务。',
          isError: true
        })
        continue
      }
    }
    gated.push(call)
  }

  const results = await executeToolBatch(gated, registry, ctx)

  for (const call of gated) {
    const result = results.get(call.id)
    if (!result?.fileChange) continue
    const fc = result.fileChange
    if (isPathDirty(fc.path, new Set())) {
      results.set(call.id, {
        content: `目标文件有未保存改动，已拒绝写入（dirty_conflict）：${fc.path}`,
        isError: true
      })
      continue
    }
    try {
      await ctx.snapshot?.(fc.path)
      await writeTextFile(fc.path, fc.newContent, fc.encoding)
      noteAgentWrite(fc.path)
      fileChanges.set(call.id, { path: fc.path, diff: fc.diff, isCreate: fc.isCreate })
      results.set(call.id, { content: `已${fc.isCreate ? '创建' : '修改'}：${fc.path}` })
    } catch (e) {
      results.set(call.id, {
        content: e instanceof Error ? e.message : '写入失败',
        isError: true
      })
    }
  }

  for (const [id, result] of denied) results.set(id, result)
  return results
}

export interface RunSubagentOptions {
  workspaceRoot: string | null
  sessionId?: string
  signal?: AbortSignal
  turnId?: string
  subagentId?: string
  emitEvent?: (event: AgentEvent) => void
  initialMessages?: ChatMessage[]
  forkContextMessages?: ChatMessage[]
  contentReplacementState?: ContentReplacementState
  agentDefinition?: AgentDefinition
  permissionMode?: 'default' | 'acceptEdits'
  snapshot?: (absPath: string) => Promise<void>
  handoffInputs?: string
}

export async function runReadOnlySubagent(
  input: RunSubagentInput,
  options: RunSubagentOptions
): Promise<{
  finalText: string
  usage?: TokenUsage
  durationMs: number
  isError?: boolean
  messages?: ChatMessage[]
  replacementRecords?: ContentReplacementRecord[]
  modelLabel?: string
}> {
  const started = Date.now()
  const definition = options.agentDefinition ?? getAgentDefinition(input.subagentType, options.workspaceRoot)
  let profile: ReturnType<typeof getProfileRaw> | null = null
  let apiKey: string | null = null
  // 模型优先级：调用时显式传入的 input.model > 项目 agent 定义的默认 model > 当前激活模型。
  const requestedModel = input.model?.trim() || definition.model?.trim() || undefined
  const requested = requestedModel ? resolveProfileByIdOrName(requestedModel) : null
  try {
    if (requested) {
      profile = requested
      apiKey = getProfileApiKey(requested)
    } else {
      const profileId = getActiveProfileId()
      profile = profileId ? getProfileRaw(profileId) : null
      apiKey = getActiveProfileApiKey()
    }
  } catch {
    profile = null
  }
  if (!profile) {
    return {
      finalText: '尚未配置或激活 Provider，请在设置中配置后重试。',
      durationMs: Date.now() - started,
      isError: true
    }
  }

  let adapter
  try {
    adapter = createAdapter(profile, apiKey)
  } catch (e) {
    return {
      finalText: e instanceof Error ? e.message : '创建 Provider 失败',
      durationMs: Date.now() - started,
      isError: true
    }
  }

  // 标注本次子 Agent 实际使用的模型；指定的模型解析失败时回退激活模型并说明。
  const modelLabel = requested
    ? `${profile.name}（${profile.model}）`
    : requestedModel
      ? `${profile.name}（${profile.model}，未匹配到「${requestedModel}」已回退激活模型）`
      : `${profile.name}（${profile.model}）`

  const registry = subagentRegistry(definition)
  const permissionEngine = new PermissionEngine()
  permissionEngine.loadRules(options.workspaceRoot)
  const permissionMode = options.permissionMode ?? 'default'
  const ctx: PromptContext = {
    appName: APP_NAME,
    os: process.platform,
    date: todayISODate(),
    shell: currentShellName(),
    responseLanguage: DEFAULT_RESPONSE_LANGUAGE,
    workspacePath: options.workspaceRoot ?? undefined,
    model: profile.model,
    enabledTools: registry.all().map((t) => t.name),
    permissionMode: 'default',
    isSubagent: true
  }

  let systemText: string
  try {
    systemText = assembleSystemMessage(await fetchSystemPromptPartsAsync(ctx, options.signal))
  } catch (e) {
    return {
      finalText: e instanceof Error ? e.message : '组装子 Agent 提示词失败',
      durationMs: Date.now() - started,
      isError: true
    }
  }

  // 与主 QueryEngine 一致：权限模式标注单独注入消息尾部，不写入历史。
  const dynamicContextBlock = fetchDynamicContextBlock(ctx)

  const contentReplacementState = options.contentReplacementState ?? createContentReplacementState()
  const toolCtx: ToolContext = {
    workspaceRoot: options.workspaceRoot,
    sessionId: options.sessionId,
    signal: options.signal,
    permissionMode,
    snapshot: options.snapshot,
    contentReplacementState
  }
  const toolDefs = registry.all().map((t) => ({
    name: t.name,
    description: t.description,
    parameters: (() => {
      const json = z.toJSONSchema(t.schema) as Record<string, unknown>
      delete json.$schema
      return json
    })()
  }))
  const forkContext = input.forkContext ? buildForkContext(options.forkContextMessages) : undefined
  const messages: ChatMessage[] = [
    ...(options.initialMessages ?? []),
    { role: 'user', content: makeSubagentPrompt(input, definition, forkContext, options.handoffInputs) }
  ]
  let finalText = ''
  let usage: TokenUsage | undefined
  const fileChanges = new Map<string, AppliedFileChange>()
  const partialResult = (text: string, isError = true) => ({
    finalText: text,
    durationMs: Date.now() - started,
    usage,
    isError,
    messages,
    replacementRecords: exportContentReplacementRecords(contentReplacementState),
    modelLabel
  })

  try {
    while (true) {
      if (options.signal?.aborted) throw new ProviderError('cancelled', '已取消')

      const acc = new ToolCallAccumulator()
      let roundText = ''
      let roundInputTokens = 0
      let roundOutputTokens = 0

      for await (const chunk of adapter.streamChat(
        {
          model: profile.model,
          messages: [
            { role: 'system', content: systemText },
            ...(dynamicContextBlock ? [{ role: 'system' as const, content: dynamicContextBlock }] : []),
            ...messages
          ],
          maxOutputTokens: profile.maxOutputTokens,
          ...(toolDefs.length ? { tools: toolDefs } : {})
        },
        options.signal
      )) {
        if (chunk.type === 'text') {
          roundText += chunk.text
          if (options.turnId && options.subagentId) {
            options.emitEvent?.({
              type: 'subagent_delta',
              turnId: options.turnId,
              subagentId: options.subagentId,
              content: chunk.text
            })
          }
        } else if (chunk.type === 'thinking') {
          
        } else if (chunk.type === 'tool_call_delta') acc.add(chunk)
        else if (chunk.type === 'usage') {
          roundInputTokens += chunk.inputTokens ?? 0
          roundOutputTokens += chunk.outputTokens ?? 0
        }
      }

      if (roundInputTokens > 0 || roundOutputTokens > 0) {
        usage = {
          inputTokens: (usage?.inputTokens ?? 0) + roundInputTokens,
          outputTokens: (usage?.outputTokens ?? 0) + roundOutputTokens,
          apiInputTokens: (usage?.apiInputTokens ?? 0) + roundInputTokens,
          apiOutputTokens: (usage?.apiOutputTokens ?? 0) + roundOutputTokens
        }
      }

      const calls = acc.finalize()
      if (calls.length === 0) {
        finalText = roundText
        messages.push({ role: 'assistant', content: roundText })
        break
      }

      messages.push({ role: 'assistant', content: roundText, toolCalls: calls })
      const startTimes = new Map<string, number>()
      if (options.turnId && options.subagentId) {
        for (const call of calls) {
          startTimes.set(call.id, Date.now())
          const parsed = parseToolArguments(call.arguments)
          options.emitEvent?.({
            type: 'subagent_tool_start',
            turnId: options.turnId,
            subagentId: options.subagentId,
            callId: call.id,
            name: call.name,
            args: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
          })
        }
      }
      const results = await executeSubagentToolBatch(
        calls,
        registry,
        toolCtx,
        permissionEngine,
        permissionMode,
        fileChanges
      )
      const budgetedResults = externalizeToolResultsWithState(calls, results, contentReplacementState)
      for (const call of calls) {
        const result = budgetedResults.get(call.id) ?? { content: '(无结果)' }
        const durationMs = startTimes.has(call.id) ? Date.now() - startTimes.get(call.id)! : undefined
        if (options.turnId && options.subagentId) {
          const fc = fileChanges.get(call.id)
          options.emitEvent?.({
            type: 'subagent_tool_result',
            turnId: options.turnId,
            subagentId: options.subagentId,
            callId: call.id,
            result: result.content,
            isError: result.isError,
            truncated: result.truncated,
            durationMs,
            filePath: fc?.path,
            fileDiff: fc?.diff,
            isCreate: fc?.isCreate
          })
        }
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: result.isError ? `工具执行失败：${result.content}` : result.content
        })
      }
    }
  } catch (e) {
    return partialResult(e instanceof Error ? e.message : '子 Agent 执行失败')
  }

  if (!usage) {
    const estimatedPromptTokens = countChatMessagesTokens(
      [{ role: 'system', content: systemText }, ...messages],
      profile.model,
      profile.kind
    )
    const estimatedOutputTokens = countTokens(finalText, profile.model, profile.kind)
    usage = {
      inputTokens: estimatedPromptTokens,
      outputTokens: estimatedOutputTokens,
      estimatedPromptTokens,
      estimatedOutputTokens
    }
  }

  return {
    finalText,
    usage,
    durationMs: Date.now() - started,
    messages,
    replacementRecords: exportContentReplacementRecords(contentReplacementState),
    modelLabel
  }
}

export interface RunSubagentToolOptions {
  resolveAgentDefinition?: (input: RunSubagentInput, workspaceRoot: string | null) => AgentDefinition | undefined
}

export function createRunSubagentTool(options: RunSubagentToolOptions = {}): Tool<RunSubagentInput> {
  return {
    name: RUN_SUBAGENT_NAME,
    description: RUN_SUBAGENT_DESCRIPTION,
    schema: runSubagentSchema,
    readOnly: true,
    
    
    
    concurrencySafe: true,
    async execute(input, ctx): Promise<ToolResult> {
      const turnId = ctx.turnId ?? createSubagentId()
      const resumeRecord = input.resumeSubagentId ? loadSubagentTranscript(input.resumeSubagentId) : undefined
      const subagentId = resumeRecord?.id ?? createSubagentId()
      const startedInput = resumeRecord
        ? {
            ...resumeRecord.input,
            description: input.description || resumeRecord.input.description,
            task: input.task,
            subagentType: input.subagentType ?? resumeRecord.input.subagentType,
            model: input.model ?? resumeRecord.input.model,
            expectedOutput: input.expectedOutput ?? resumeRecord.input.expectedOutput,
            runInBackground: input.runInBackground,
            forkContext: input.forkContext ?? resumeRecord.input.forkContext,
            isolatedWorktree: input.isolatedWorktree ?? resumeRecord.input.isolatedWorktree,
            inputsFromSubagentIds: input.inputsFromSubagentIds ?? resumeRecord.input.inputsFromSubagentIds
          }
        : input

      if (input.resumeSubagentId && !resumeRecord) {
        return { content: `未找到可恢复的子 Agent：${input.resumeSubagentId}`, isError: true }
      }

      if (resumeRecord?.status === 'running') {
        return {
          content: `子 Agent 仍在后台运行：${resumeRecord.id}\n状态：running\n任务：${resumeRecord.input.description}`
        }
      }

      const definition = options.resolveAgentDefinition?.(startedInput, ctx.workspaceRoot) ?? getAgentDefinition(startedInput.subagentType, ctx.workspaceRoot)
      const isolatedWorktree = startedInput.isolatedWorktree
        ? createIsolatedWorktree(ctx.workspaceRoot, subagentId)
        : null
      if (isolatedWorktree && 'error' in isolatedWorktree) {
        return { content: isolatedWorktree.error, isError: true }
      }
      const effectiveWorkspaceRoot = isolatedWorktree?.path ?? ctx.workspaceRoot

      ctx.emitEvent?.({
        type: 'subagent_start',
        turnId,
        subagentId,
        callId: ctx.toolCallId ?? subagentId,
        description: startedInput.description,
        task: startedInput.task,
        background: input.runInBackground,
        subagentType: definition.id,
        readOnly: definition.readOnly,
        model: resolveSubagentModelLabel(startedInput.model, definition.model)
      })

      const backgroundController = input.runInBackground ? new AbortController() : null
      const handoffInputs = resolveHandoffInputs(startedInput.inputsFromSubagentIds)
      const runOptions: RunSubagentOptions = {
        workspaceRoot: effectiveWorkspaceRoot,
        sessionId: ctx.sessionId,
        signal: backgroundController?.signal ?? ctx.signal,
        turnId,
        subagentId,
        emitEvent: input.runInBackground ? undefined : ctx.emitEvent,
        initialMessages: resumeRecord?.messages,
        forkContextMessages: ctx.parentMessages,
        contentReplacementState: resumeRecord
          ? createContentReplacementStateFromRecords(resumeRecord.replacementRecords)
          : ctx.contentReplacementState
            ? cloneContentReplacementState(ctx.contentReplacementState)
            : undefined,
        agentDefinition: definition,
        permissionMode: ctx.permissionMode ?? 'default',
        snapshot: ctx.snapshot,
        handoffInputs
      }

      if (input.runInBackground) {
        if (backgroundController) backgroundSubagentControllers.set(subagentId, backgroundController)
        saveSubagentTranscript({
          id: subagentId,
          input: startedInput,
          messages: resumeRecord?.messages ?? [],
          status: 'running',
          parentSessionId: ctx.sessionId,
          replacementRecords: resumeRecord?.replacementRecords,
          updatedAt: Date.now()
        })
        void runReadOnlySubagent(startedInput, runOptions)
          .then((result) => {
            const wasCancelled = backgroundController?.signal.aborted === true
            const failureSummary = wasCancelled
              ? '用户取消了后台子 Agent。'
              : result.isError ? result.finalText.slice(0, 240) : undefined
            const status = wasCancelled ? 'cancelled' : result.isError ? 'error' : 'completed'
            saveSubagentTranscript({
              id: subagentId,
              input: startedInput,
              messages: result.messages ?? resumeRecord?.messages ?? [],
              status,
              finalText: wasCancelled ? '后台子 Agent 已取消。' : result.finalText,
              usage: result.usage,
              durationMs: result.durationMs,
              failureSummary,
              parentSessionId: ctx.sessionId,
              replacementRecords: result.replacementRecords ?? resumeRecord?.replacementRecords,
              updatedAt: Date.now()
            })
            emitBackgroundSubagentEvent(ctx.sessionId, {
              type: 'subagent_end',
              turnId,
              subagentId,
              callId: subagentId,
              status: wasCancelled || result.isError ? 'error' : 'completed',
              finalText: wasCancelled ? '后台子 Agent 已取消。' : result.finalText,
              usage: result.usage,
              durationMs: result.durationMs,
              failureSummary,
              background: true
            })
          })
          .finally(() => {
            backgroundSubagentControllers.delete(subagentId)
            isolatedWorktree?.cleanup()
          })
        return {
          content: [
            `Background sub-agent started: ${startedInput.description}`,
            `Subagent ID: ${subagentId}`,
            'This is only a start confirmation — the result is NOT available yet and will NOT arrive later in this turn.',
            'Do NOT use Sleep or repeated checks to wait for it. Continue with other independent work or end your turn now; the user will be notified when it finishes and can hand the result back to you.'
          ].join('\n')
        }
      }

      const result = await runReadOnlySubagent(startedInput, runOptions)
      const failureSummary = result.isError ? result.finalText.slice(0, 240) : undefined
      saveSubagentTranscript({
        id: subagentId,
        input: startedInput,
        messages: result.messages ?? resumeRecord?.messages ?? [],
        status: result.isError ? 'error' : 'completed',
        finalText: result.finalText,
        usage: result.usage,
        durationMs: result.durationMs,
        failureSummary,
        parentSessionId: ctx.sessionId,
        replacementRecords: result.replacementRecords ?? resumeRecord?.replacementRecords,
        updatedAt: Date.now()
      })
      ctx.emitEvent?.({
        type: 'subagent_end',
        turnId,
        subagentId,
        callId: subagentId,
        status: result.isError ? 'error' : 'completed',
        finalText: result.finalText,
        usage: result.usage,
        durationMs: result.durationMs,
        failureSummary
      })
      isolatedWorktree?.cleanup()
      return {
        content: `${formatSubagentResult(startedInput, result.finalText, {
          usage: result.usage,
          durationMs: result.durationMs,
          failureSummary
        })}${result.modelLabel ? `\nModel: ${result.modelLabel}` : ''}\n\nSubagent ID: ${subagentId}`,
        isError: result.isError
      }
    }
  }
}

export function createSubagentId(): string {
  return `subagent-${randomUUID()}`
}

// 解析子 Agent 将要使用的模型显示名：优先 explicit（调用传入），其次 definition 默认，回退当前激活模型。
function resolveSubagentModelLabel(explicit: string | undefined, definitionModel?: string | undefined): string | undefined {
  const requested = explicit?.trim() || definitionModel?.trim() || undefined
  try {
    if (requested) {
      const matched = resolveProfileByIdOrName(requested)
      if (matched) return `${matched.name}（${matched.model}）`
      const activeId = getActiveProfileId()
      const active = activeId ? getProfileRaw(activeId) : null
      return active ? `${active.name}（${active.model}，未匹配「${requested}」已回退）` : undefined
    }
    const activeId = getActiveProfileId()
    const active = activeId ? getProfileRaw(activeId) : null
    return active ? `${active.name}（${active.model}）` : undefined
  } catch {
    return undefined
  }
}
