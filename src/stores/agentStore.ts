import { create } from 'zustand'
import { appStorageKey } from '@shared/appConfig'
import type {
  AgentEvent,
  ContextAttachment,
  EditorContextSnapshot,
  FileChangeDecision,
  ImageAttachment,
  PermissionDecision,
  UserQuestionResponse,
  ContentReplacementRecord,
  PersistedChatMessage,
  PersistedSession,
  ProviderProfileSummary,
  TokenUsage,
  AgentTask
} from '@shared/agentTypes'
import { useEditorStore } from '@/stores/editorStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useInlineDiffStore } from '@/stores/inlineDiffStore'
import { toast } from '@/stores/toastStore'
import { getEditorInstance } from '@/components/Editor/editorBridge'
import { syncEditorDirtyPaths } from '@/utils/syncEditorSnapshot'


export interface SessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number

  cwd: string | null
}

const DEFAULT_SESSION_TITLE = '新对话'
const AGENT_PREFS_KEY = appStorageKey('agent-preferences')

type PermissionMode = 'default' | 'acceptEdits'

interface AgentPreferences {
  permissionMode: PermissionMode
}

const DEFAULT_AGENT_PREFERENCES: AgentPreferences = {
  permissionMode: 'default'
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return value === 'default' || value === 'acceptEdits'
}

function loadAgentPreferences(): AgentPreferences {
  try {
    const raw = localStorage.getItem(AGENT_PREFS_KEY)
    if (!raw) return { ...DEFAULT_AGENT_PREFERENCES }
    const parsed = JSON.parse(raw) as Partial<AgentPreferences>
    return {
      permissionMode: isPermissionMode(parsed.permissionMode)
        ? parsed.permissionMode
        : DEFAULT_AGENT_PREFERENCES.permissionMode
    }
  } catch {
    return { ...DEFAULT_AGENT_PREFERENCES }
  }
}

function saveAgentPreferences(patch: Partial<AgentPreferences>): void {
  try {
    const next = { ...loadAgentPreferences(), ...patch }
    localStorage.setItem(AGENT_PREFS_KEY, JSON.stringify(next))
  } catch {
    
  }
}

function deriveTitle(text: string): string {
  const firstLine = text.trim().split(/\r?\n/)[0]?.trim() ?? ''
  if (!firstLine) return DEFAULT_SESSION_TITLE
  return firstLine.length > 30 ? firstLine.slice(0, 30) + '…' : firstLine
}


const hydratedMain = new Set<string>(['default'])

function revertFailMessage(reason?: string): string {
  switch (reason) {
    case 'dirty':
      return '该文件有未保存的改动，已取消操作，请先保存或放弃改动'
    case 'not_found':
      return '该变更已不可撤销（可能因会话重启或已被清理）'
    default:
      return '操作失败，请重试'
  }
}

// 单卡片撤销/取消撤销的进行中锁：同一 changeId 的 IPC 未返回前禁止重入，
// 避免用户快速连点导致乐观 UI 状态与磁盘实际写入顺序交错、最终不一致。
const fileChangeInFlight = new Set<string>()

export interface SubagentTabView {
  id: string
  title: string
  status: 'running' | 'completed' | 'error'
  messages: ChatMessageView[]
  usage?: TokenUsage
  durationMs?: number
  failureSummary?: string
  
  background?: boolean
  
  handedBack?: boolean
  
  subagentType?: string
  
  readOnly?: boolean
}

export interface ChatMessageView {
  id: string
  role: 'user' | 'assistant' | 'error' | 'tool' | 'permission' | 'question' | 'filechange' | 'notice' | 'subagent'
  content: string
  thinking?: string
  
  streaming?: boolean
  
  stopped?: boolean
  
  errorCode?: string
  
  toolName?: string
  toolStatus?: 'running' | 'background' | 'deferred' | 'done' | 'error'
  toolArgs?: Record<string, unknown>
  toolResult?: string
  toolProgress?: string[]
  
  toolStream?: string
  backgroundId?: string
  deferredId?: string
  toolTruncated?: boolean
  toolDurationMs?: number
  
  toolStartedAt?: number
  
  permissionStatus?: 'pending' | 'allow' | 'deny'
  permissionCommand?: string
  
  questionStatus?: 'pending' | 'answered' | 'cancelled'
  questionSuggestions?: string[]
  
  questionPreviewImageId?: string
  structuredQuestions?: import('@shared/agentTypes').AskUserQuestionItem[]
  questionAnswer?: string
  questionAnswers?: Record<string, string>
  
  filePath?: string
  fileDiff?: string
  fileStatus?: 'streaming' | 'proposed' | 'applied' | 'rejected' | 'reverted'
  fileChangeCallId?: string
  // 后端 fileChangeHistory 是否持有该变更的可撤销快照（仅本次运行内有效）。
  // 重启 / 切换会话后从磁盘恢复的卡片不会带此标记，撤销按钮因此不显示，
  // 避免点击一个后端已无记录的“假撤销”按钮。
  fileRevertable?: boolean
  
  turnId?: string
  
  images?: ImageAttachment[]
  
  // 模型流式生成图片时的中间预览（按 index → data URL）。最终图落盘后写入 content markdown。
  partialImages?: Record<number, string>
  
  subagent?: SubagentTabView
  
  subagentCallId?: string
}

interface AgentState {
  messages: ChatMessageView[]
  
  sessions: SessionMeta[]
  
  currentSessionId: string
  
  currentWorkspaceId: string | null
  
  openTabs: string[]
  
  sessionMessages: Record<string, ChatMessageView[]>
  
  sessionCanRevert: Record<string, boolean>
  
  tasks: AgentTask[]
  
  sessionTasks: Record<string, AgentTask[]>
  
  permissionMode: PermissionMode
  streaming: boolean
  currentTurnId: string | null
  
  currentAssistantId: string | null
  
  sessionStreaming: Record<string, { streaming: boolean; turnId: string | null; assistantId: string | null }>
  
  sessionAttention: Record<string, boolean>
  
  canRevert: boolean
  activeProfile: ProviderProfileSummary | null
  
  lastTokenUsage: TokenUsage | null
  
  sessionTokenUsage: Record<string, TokenUsage | null>
  
  lastUserText: string | null
  initialized: boolean

  init: () => void
  loadSessions: () => Promise<void>

  loadAllSessions: () => Promise<void>

  setWorkspace: (workspaceId: string | null) => Promise<void>
  newSession: (cwd?: string | null) => void
  switchSession: (id: string) => void
  deleteSession: (id: string) => void
  
  openSessionTab: (id: string) => void
  
  closeSessionTab: (id: string) => void
  setPermissionMode: (m: PermissionMode) => void
  revert: () => Promise<void>
  refreshActiveProfile: () => Promise<void>
  sendMessage: (text: string, attachments?: ContextAttachment[], images?: ImageAttachment[]) => Promise<void>
  regenerate: (assistantMessageId: string) => Promise<void>
  editAndResend: (userMessageId: string, newText: string) => Promise<void>
  stop: () => void
  retry: () => void
  clear: () => void
  respondPermission: (requestId: string, decision: PermissionDecision) => void
  respondUserQuestion: (requestId: string, response: UserQuestionResponse) => void
  respondFileChange: (changeId: string, decision: FileChangeDecision) => void
  revertFileChange: (changeId: string) => Promise<void>
  redoFileChange: (changeId: string) => Promise<void>
  
  handBackSubagent: (subagentId: string) => void
  applyEvent: (event: AgentEvent) => void
}

function uuid(): string {
  return crypto.randomUUID()
}


function summarizeArgs(args: Record<string, unknown>): string {
  const parts = Object.entries(args).map(
    ([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`
  )
  const s = parts.join(', ')
  return s.length > 200 ? s.slice(0, 200) + '…' : s
}


export function toolHeadlineArg(toolName: string | undefined, args?: Record<string, unknown>): string {
  if (!args) return ''
  const pick = (key: string): string | null => {
    const v = args[key]
    return typeof v === 'string' && v.length > 0 ? v : null
  }
  switch (toolName) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
    case 'delete_file':
      return pick('path') ?? ''
    case 'list_dir':
      return pick('path') ?? '工作区根目录'
    case 'grep': {
      const q = pick('query') ?? ''
      const p = pick('path')
      return p ? `${q}  in ${p}` : q
    }
    case 'run_terminal_cmd':
      return pick('command') ?? ''
    case 'run_subagent':
      return pick('description') ?? pick('task') ?? ''
    default:
      return summarizeArgs(args)
  }
}

function pickString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function previewDiffFromContent(content: string): string {
  if (content.length === 0) return '+正在生成文件内容…'
  const lines = content.split(/\r?\n/)
  const capped = lines.slice(0, 220)
  const body = capped.map((line) => `+${line}`).join('\n')
  return capped.length < lines.length ? `${body}\n+…（内容仍在生成，预览已截断）` : body
}

function previewDiffFromEdit(args: Record<string, unknown>): string {
  const oldText = pickString(args, 'old_string') ?? ''
  const newText = pickString(args, 'new_string') ?? ''
  const oldLines = oldText ? oldText.split(/\r?\n/).slice(0, 80).map((line) => `-${line}`) : []
  const newLines = newText ? newText.split(/\r?\n/).slice(0, 120).map((line) => `+${line}`) : []
  return [...oldLines, ...newLines].join('\n') || '+正在生成修改预览…'
}

function isStreamingFileTool(toolName: string | undefined): toolName is 'write_file' | 'edit_file' {
  return toolName === 'write_file' || toolName === 'edit_file'
}

function normalizePathForCompare(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase()
}

function pathsLikelyMatch(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  const left = normalizePathForCompare(a)
  const right = normalizePathForCompare(b)
  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`)
}

function previewFileChangeFromArgs(
  toolName: string | undefined,
  args: Record<string, unknown>,
  callId: string,
  turnId: string
): ChatMessageView | null {
  if (!isStreamingFileTool(toolName)) return null
  const path = pickString(args, 'path')
  return {
    id: `preview-${callId}`,
    role: 'filechange',
    turnId,
    filePath: path ?? '',
    fileDiff: toolName === 'write_file'
      ? previewDiffFromContent(pickString(args, 'content') ?? '')
      : previewDiffFromEdit(args),
    fileStatus: 'streaming',
    fileChangeCallId: callId,
    content: ''
  }
}

function previewFileChangeFromToolStart(
  event: Extract<AgentEvent, { type: 'tool_call_start' }>
): ChatMessageView | null {
  return previewFileChangeFromArgs(event.name, event.args, event.callId, event.turnId)
}

function tryParseArgsText(argsText: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(argsText) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function decodeJsonStringPrefix(raw: string): string {
  let candidate = raw
  while (candidate.endsWith('\\')) candidate = candidate.slice(0, -1)
  try {
    return JSON.parse(`"${candidate.replace(/"/g, '\\"')}"`) as string
  } catch {
    return candidate
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
  }
}

function extractJsonStringPrefix(argsText: string, key: string): string | null {
  const keyMatch = new RegExp(`"${key}"\\s*:\\s*"`).exec(argsText)
  if (!keyMatch) return null
  let raw = ''
  let escaping = false
  for (let i = keyMatch.index + keyMatch[0].length; i < argsText.length; i++) {
    const ch = argsText[i]
    if (escaping) {
      raw += `\\${ch}`
      escaping = false
      continue
    }
    if (ch === '\\') {
      escaping = true
      continue
    }
    if (ch === '"') break
    raw += ch
  }
  return decodeJsonStringPrefix(raw)
}

function argsFromToolDelta(event: Extract<AgentEvent, { type: 'tool_call_delta' }>): Record<string, unknown> {
  const parsed = tryParseArgsText(event.argsText)
  if (parsed) return parsed

  const args: Record<string, unknown> = {}
  for (const key of ['path', 'content', 'old_string', 'new_string']) {
    const value = extractJsonStringPrefix(event.argsText, key)
    if (value != null) args[key] = value
  }
  return args
}

function inferFileToolName(
  explicitName: string | undefined,
  args: Record<string, unknown>
): string | undefined {
  if (explicitName === 'write_file' || explicitName === 'edit_file') return explicitName
  if (typeof args.content === 'string') return 'write_file'
  if (typeof args.old_string === 'string' || typeof args.new_string === 'string') return 'edit_file'
  return explicitName
}


interface SessionRuntime {
  messages: ChatMessageView[]
  streaming: boolean
  turnId: string | null
  assistantId: string | null
  canRevert: boolean
}

function hasPendingAttention(messages: ChatMessageView[]): boolean {
  return messages.some(
    (m) =>
      (m.role === 'permission' && m.permissionStatus === 'pending') ||
      (m.role === 'question' && m.questionStatus === 'pending')
  )
}

function reduceSessionEvent(rt: SessionRuntime, event: AgentEvent): SessionRuntime {
  const finalizeStreaming = (msgs: ChatMessageView[]): ChatMessageView[] =>
    msgs.map((m) => (m.id === rt.assistantId ? { ...m, streaming: false } : m))

  switch (event.type) {
    case 'turn_start':
      return { ...rt, streaming: true, turnId: event.turnId, assistantId: null }
    case 'text_delta': {
      if (rt.assistantId) {
        return {
          ...rt,
          messages: rt.messages.map((m) =>
            m.id === rt.assistantId ? { ...m, content: m.content + event.content } : m
          )
        }
      }
      const newId = uuid()
      return {
        ...rt,
        assistantId: newId,
        messages: [
          ...rt.messages,
          { id: newId, role: 'assistant', content: event.content, streaming: true, turnId: event.turnId }
        ]
      }
    }
    case 'workspace_root_changed':
      return {
        ...rt,
        messages: [
          ...rt.messages,
          {
            id: uuid(),
            role: 'notice',
            turnId: event.turnId,
            content: event.workspaceRoot
              ? `当前 Agent session 工作区已切换到：${event.workspaceRoot}`
              : '当前 Agent session 工作区覆盖已清除。'
          }
        ]
      }
    case 'thinking_delta': {
      if (rt.assistantId) {
        return {
          ...rt,
          messages: rt.messages.map((m) =>
            m.id === rt.assistantId ? { ...m, thinking: (m.thinking ?? '') + event.content } : m
          )
        }
      }
      const newId = uuid()
      return {
        ...rt,
        assistantId: newId,
        messages: [
          ...rt.messages,
          {
            id: newId,
            role: 'assistant',
            content: '',
            thinking: event.content,
            streaming: true,
            turnId: event.turnId
          }
        ]
      }
    }
    case 'image_progress': {
      const targetId = rt.assistantId
      if (targetId) {
        return {
          ...rt,
          messages: rt.messages.map((m) =>
            m.id === targetId ? { ...m, partialImages: { ...(m.partialImages ?? {}), [event.index]: event.dataUrl } } : m
          )
        }
      }
      const newId = uuid()
      return {
        ...rt,
        assistantId: newId,
        messages: [
          ...rt.messages,
          { id: newId, role: 'assistant', content: '', streaming: true, turnId: event.turnId, partialImages: { [event.index]: event.dataUrl } }
        ]
      }
    }
    case 'tool_call_delta': {
      const args = argsFromToolDelta(event)
      const toolName = inferFileToolName(event.name, args)
      const preview = previewFileChangeFromArgs(toolName, args, event.callId, event.turnId)
      if (!preview) return rt
      const messages = finalizeStreaming(rt.messages)
      const existingIdx = messages.findIndex(
        (m) => m.role === 'filechange' && m.fileStatus === 'streaming' && m.fileChangeCallId === event.callId
      )
      if (existingIdx !== -1) {
        const copy = [...messages]
        copy[existingIdx] = { ...copy[existingIdx], filePath: preview.filePath, fileDiff: preview.fileDiff }
        return { ...rt, assistantId: null, messages: copy }
      }
      return { ...rt, assistantId: null, messages: [...messages, preview] }
    }
    case 'tool_call_start': {
      const alreadyHasPreview = rt.messages.some(
        (m) => m.role === 'filechange' && m.fileStatus === 'streaming' && m.fileChangeCallId === event.callId
      )
      let preview = previewFileChangeFromToolStart(event)
      if (!preview && !alreadyHasPreview && (event.name === 'write_file' || event.name === 'edit_file')) {
        const path = pickString(event.args as Record<string, unknown>, 'path')
        preview = {
          id: `preview-${event.callId}`,
          role: 'filechange',
          turnId: event.turnId,
          filePath: path ?? '',
          fileDiff: '+正在生成…',
          fileStatus: 'streaming',
          fileChangeCallId: event.callId,
          content: ''
        }
      }
      return {
        ...rt,
        assistantId: null,
        messages: [
          ...finalizeStreaming(rt.messages),
          {
            id: event.callId,
            role: 'tool',
            turnId: event.turnId,
            toolName: event.name,
            toolStatus: 'running',
            toolArgs: event.args,
            toolStartedAt: Date.now(),
            content: summarizeArgs(event.args)
          },
          ...(preview && !alreadyHasPreview ? [preview] : [])
        ]
      }
    }
    case 'tool_call_progress':
      return {
        ...rt,
        messages: rt.messages.map((m) => {
          if (m.id !== event.callId || m.role !== 'tool') return m
          const nextProgress = event.message
            ? [...(m.toolProgress ?? []), event.message].slice(-20)
            : m.toolProgress
          const nextStream =
            event.chunk !== undefined
              ? ((m.toolStream ?? '') + event.chunk).slice(-32_000)
              : m.toolStream
          return {
            ...m,
            toolStatus: event.status === 'error'
              ? 'error'
              : event.status === 'completed'
                ? m.toolStatus ?? 'running'
                : event.backgroundId ?? event.deferredId
                  ? 'background'
                  : 'running',
            toolProgress: nextProgress,
            toolStream: nextStream,
            backgroundId: event.backgroundId ?? m.backgroundId,
            deferredId: event.deferredId ?? m.deferredId
          }
        })
      }
    case 'subagent_start': {
      const existing = rt.messages.find((m) => m.id === event.subagentId && m.role === 'subagent')
      const promptMessage: ChatMessageView = {
        id: `${event.subagentId}-prompt-${event.turnId}`,
        role: 'user',
        turnId: event.turnId,
        content: event.task
      }
      if (existing) {
        return {
          ...rt,
          messages: rt.messages.map((m) => {
            if (m.id !== event.subagentId || m.role !== 'subagent' || !m.subagent) return m
            const finalized = m.subagent.messages.map((im) => (im.streaming ? { ...im, streaming: false } : im))
            return {
              ...m,
              turnId: event.turnId,
              content: event.description,
              subagentCallId: event.callId,
              subagent: {
                ...m.subagent,
                title: event.description,
                status: 'running',
                background: event.background ?? m.subagent.background,
                subagentType: event.subagentType ?? m.subagent.subagentType,
                readOnly: event.readOnly ?? m.subagent.readOnly,
                messages: [...finalized, promptMessage]
              }
            }
          })
        }
      }
      return {
        ...rt,
        messages: [
          ...rt.messages,
          {
            id: event.subagentId,
            role: 'subagent',
            turnId: event.turnId,
            content: event.description,
            subagentCallId: event.callId,
            subagent: {
              id: event.subagentId,
              title: event.description,
              status: 'running',
              background: event.background,
              subagentType: event.subagentType,
              readOnly: event.readOnly,
              messages: [promptMessage]
            }
          }
        ]
      }
    }
    case 'subagent_delta':
      return {
        ...rt,
        messages: rt.messages.map((m) => {
          if (m.id !== event.subagentId || m.role !== 'subagent' || !m.subagent) return m
          const inner = [...m.subagent.messages]
          const last = inner[inner.length - 1]
          if (last?.role === 'assistant' && last.streaming) {
            inner[inner.length - 1] = { ...last, content: last.content + event.content }
          } else {
            inner.push({
              id: `${event.subagentId}-assistant-${inner.length}`,
              role: 'assistant',
              turnId: event.turnId,
              content: event.content,
              streaming: true
            })
          }
          return { ...m, subagent: { ...m.subagent, messages: inner } }
        })
      }
    case 'subagent_tool_start':
      return {
        ...rt,
        messages: rt.messages.map((m) => {
          if (m.id !== event.subagentId || m.role !== 'subagent' || !m.subagent) return m
          const inner = m.subagent.messages.map((im) => (im.streaming ? { ...im, streaming: false } : im))
          inner.push({
            id: `${event.subagentId}-${event.callId}`,
            role: 'tool',
            turnId: event.turnId,
            toolName: event.name,
            toolStatus: 'running',
            toolArgs: event.args,
            toolStartedAt: Date.now(),
            content: summarizeArgs(event.args)
          })
          return { ...m, subagent: { ...m.subagent, messages: inner } }
        })
      }
    case 'subagent_tool_result':
      return {
        ...rt,
        messages: rt.messages.map((m) => {
          if (m.id !== event.subagentId || m.role !== 'subagent' || !m.subagent) return m
          return {
            ...m,
            subagent: {
              ...m.subagent,
              messages: m.subagent.messages.map((im) => {
                if (im.id !== `${event.subagentId}-${event.callId}`) return im
                const duration = event.durationMs ?? (im.toolStartedAt !== undefined ? Date.now() - im.toolStartedAt : undefined)
                if (event.fileDiff && event.filePath && !event.isError) {
                  return {
                    ...im,
                    role: 'filechange',
                    filePath: event.filePath,
                    fileDiff: event.fileDiff,
                    fileStatus: 'applied',
                    fileChangeCallId: event.callId,
                    content: ''
                  }
                }
                return {
                  ...im,
                  toolStatus: event.isError ? 'error' : 'done',
                  toolResult: event.result,
                  toolTruncated: event.truncated,
                  toolDurationMs: duration
                }
              })
            }
          }
        })
      }
    case 'subagent_end':
      return {
        ...rt,
        messages: rt.messages.map((m) => {
          if (m.id !== event.subagentId || m.role !== 'subagent' || !m.subagent) return m
          const finalizedMessages = m.subagent.messages.map((im) => (im.streaming ? { ...im, streaming: false } : im))
          const last = finalizedMessages[finalizedMessages.length - 1]
          const shouldAppendFinal =
            event.status === 'error' ||
            !(last?.role === 'assistant' && last.content.trim() === event.finalText.trim())
          return {
            ...m,
            subagent: {
              ...m.subagent,
              status: event.status,
              usage: event.usage,
              durationMs: event.durationMs,
              failureSummary: event.failureSummary,
              background: event.background ?? m.subagent.background,
              messages: shouldAppendFinal
                ? [
                    ...finalizedMessages,
                    {
                      id: `${event.subagentId}-final-${event.turnId}`,
                      role: event.status === 'error' ? 'error' : 'assistant',
                      turnId: event.turnId,
                      content: event.finalText
                    }
                  ]
                : finalizedMessages
            }
          }
        })
      }
    case 'tool_call_result': {
      const isError = !!(event.isError || event.status === 'error')
      return {
        ...rt,
        messages: rt.messages
          .filter((m) => {
            if (m.role === 'filechange' && m.fileStatus === 'streaming' && m.fileChangeCallId === event.callId) {
              return !isError
            }
            return true
          })
          .map((m) => {
            if (m.id !== event.callId) return m
            const duration = event.durationMs ?? (m.toolStartedAt !== undefined ? Date.now() - m.toolStartedAt : undefined)
            return {
              ...m,
              toolStatus: event.status === 'pending' ? 'background' : isError ? 'error' : 'done',
              toolResult: event.result,
              toolTruncated: event.truncated,
              toolDurationMs: event.status === 'pending' ? m.toolDurationMs : duration,
              backgroundId: event.backgroundId ?? m.backgroundId,
              deferredId: event.deferredId ?? m.deferredId
            }
          })
      }
    }
    case 'permission_request':
      return {
        ...rt,
        assistantId: null,
        messages: [
          ...finalizeStreaming(rt.messages),
          {
            id: event.requestId,
            role: 'permission',
            turnId: event.turnId,
            toolName: event.tool,
            content: event.summary,
            permissionStatus: 'pending',
            permissionCommand: event.details?.command
          }
        ]
      }
    case 'permission_resolved':
      return {
        ...rt,
        messages: rt.messages.map((m) =>
          m.id === event.requestId ? { ...m, permissionStatus: event.decision } : m
        )
      }
    case 'user_question':
      return {
        ...rt,
        assistantId: null,
        messages: [
          ...finalizeStreaming(rt.messages),
          {
            id: event.requestId,
            role: 'question',
            turnId: event.turnId,
            content: event.question,
            questionStatus: 'pending',
            questionSuggestions: event.suggestions,
            questionPreviewImageId: event.previewImageId,
            structuredQuestions: event.structuredQuestions
          }
        ]
      }
    case 'user_question_resolved':
      return {
        ...rt,
        messages: rt.messages.map((m) =>
          m.id === event.requestId
            ? {
                ...m,
                questionStatus: event.cancelled ? ('cancelled' as const) : ('answered' as const),
                questionAnswer: event.answer,
                questionAnswers: event.answers
              }
            : m
        )
      }
    case 'file_change_proposed': {
      const messages = finalizeStreaming(rt.messages)
      const previewIdx = messages.findIndex(
        (m) =>
          m.role === 'filechange' &&
          m.fileStatus === 'streaming' &&
          (m.fileChangeCallId === event.callId || pathsLikelyMatch(m.filePath, event.path))
      )
      const finalChange: ChatMessageView = {
        id: event.changeId,
        role: 'filechange',
        turnId: event.turnId,
        filePath: event.path,
        fileDiff: event.diff,
        fileStatus: 'proposed',
        content: ''
      }
      if (previewIdx !== -1) {
        const copy = [...messages]
        copy[previewIdx] = finalChange
        return { ...rt, assistantId: null, messages: copy }
      }
      return { ...rt, assistantId: null, messages: [...messages, finalChange] }
    }
    case 'file_change_applied':
    case 'file_change_rejected': {
      const status: 'applied' | 'rejected' =
        event.type === 'file_change_applied' ? 'applied' : 'rejected'
      const changeId = event.type === 'file_change_applied' ? event.changeId : undefined
      // 优先按 changeId 精确匹配（同回合多次改同一文件时更可靠），回退到 path 倒序匹配。
      let realIdx = changeId
        ? rt.messages.findIndex(
            (m) => m.role === 'filechange' && m.id === changeId && m.fileStatus === 'proposed'
          )
        : -1
      if (realIdx === -1) {
        const idx = [...rt.messages]
          .reverse()
          .findIndex((m) => m.role === 'filechange' && m.filePath === event.path && m.fileStatus === 'proposed')
        realIdx = idx === -1 ? -1 : rt.messages.length - 1 - idx
      }
      // 仅当后端带回 changeId（即 fileChangeHistory 已登记可撤销快照）时，
      // 才把卡片标记为可撤销。子 agent / 删除类操作不带 changeId，不会显示撤销按钮。
      const revertable = status === 'applied' && !!changeId
      const messages = rt.messages.map((m, i) =>
        i === realIdx ? { ...m, fileStatus: status, fileRevertable: revertable } : m
      )
      return { ...rt, messages, canRevert: status === 'applied' ? true : rt.canRevert }
    }
    case 'notice':
      return {
        ...rt,
        messages: [
          ...rt.messages,
          { id: uuid(), role: 'notice', content: event.message, turnId: event.turnId }
        ]
      }
    case 'warning':
      return {
        ...rt,
        messages: rt.messages.map((m) => (m.id === rt.assistantId ? { ...m, stopped: true } : m))
      }
    case 'error':
      return {
        ...rt,
        streaming: false,
        turnId: null,
        assistantId: null,
        messages: [
          ...rt.messages
            .filter((m) => !(m.role === 'filechange' && m.fileStatus === 'streaming'))
            .filter((m) => !(m.id === rt.assistantId && m.role === 'assistant' && m.content === ''))
            .map((m) => (m.id === rt.assistantId ? { ...m, streaming: false } : m)),
          { id: uuid(), role: 'error', content: event.message, errorCode: event.code }
        ]
      }
    case 'turn_end':
      return {
        ...rt,
        streaming: false,
        turnId: null,
        assistantId: null,
        messages: rt.messages
          .filter((m) => !(m.role === 'filechange' && m.fileStatus === 'streaming'))
          .map((m) => (m.streaming ? { ...m, streaming: false } : m))
      }
    default:
      return rt
  }
}


function collectEditorContext(): EditorContextSnapshot {
  const st = useEditorStore.getState()
  const tab = st.tabs.find((t) => t.path === st.activeTabPath) ?? null
  const dirtyPaths = st.tabs.filter((t) => t.dirty).map((t) => t.path)

  let selection: string | undefined
  let selectionStartLine: number | undefined
  let selectionEndLine: number | undefined
  const ed = getEditorInstance()
  if (ed) {
    const sel = ed.getSelection()
    const model = ed.getModel()
    if (sel && model && !sel.isEmpty()) {
      selection = model.getValueInRange(sel)
      selectionStartLine = sel.startLineNumber
      selectionEndLine = sel.endLineNumber
    }
  }

  return {
    workspaceRoot: useWorkspaceStore.getState().workspace?.path,
    activeFilePath: tab && tab.kind === 'text' && !tab.untitled ? tab.path : undefined,
    selection,
    selectionStartLine,
    selectionEndLine,
    cursorLine: tab?.cursorLine,
    cursorCol: tab?.cursorCol,
    dirtyPaths
  }
}


function reconstructHistory(messages: ChatMessageView[]): PersistedChatMessage[] {
  const out: PersistedChatMessage[] = []
  for (const m of messages) {
    if (m.role === 'user' && m.content.trim()) out.push({ role: 'user', content: m.content })
    else if (m.role === 'assistant' && m.content.trim())
      out.push({ role: 'assistant', content: m.content })
  }
  return out
}

function extractContentReplacementRecords(messages: ChatMessageView[]): ContentReplacementRecord[] {
  const records: ContentReplacementRecord[] = []
  for (const m of messages) {
    if (m.role === 'tool' && m.toolStatus === 'done') {
      records.push({
        kind: 'tool-result',
        toolUseId: m.id,
        ...(m.toolTruncated && typeof m.toolResult === 'string' ? { replacement: m.toolResult } : {})
      })
    }
  }
  return records
}

export const useAgentStore = create<AgentState>((set, get) => {
  const initialPreferences = loadAgentPreferences()

  const turnSessionMap = new Map<string, string>()

  const stashCurrentSessionState = (s: AgentState): Pick<AgentState, 'sessionMessages' | 'sessionCanRevert' | 'sessionTasks' | 'sessionStreaming' | 'sessionTokenUsage'> => {
    const sessionStreaming = { ...s.sessionStreaming }
    if (!s.currentSessionId) {
      return {
        sessionMessages: s.sessionMessages,
        sessionCanRevert: s.sessionCanRevert,
        sessionTasks: s.sessionTasks,
        sessionStreaming,
        sessionTokenUsage: s.sessionTokenUsage
      }
    }
    if (s.streaming) {
      sessionStreaming[s.currentSessionId] = {
        streaming: true,
        turnId: s.currentTurnId,
        assistantId: s.currentAssistantId
      }
    } else {
      delete sessionStreaming[s.currentSessionId]
    }
    return {
      sessionMessages: { ...s.sessionMessages, [s.currentSessionId]: s.messages },
      sessionCanRevert: { ...s.sessionCanRevert, [s.currentSessionId]: s.canRevert },
      sessionTasks: { ...s.sessionTasks, [s.currentSessionId]: s.tasks },
      sessionStreaming,
      sessionTokenUsage: { ...s.sessionTokenUsage, [s.currentSessionId]: s.lastTokenUsage }
    }
  }

  
  const persistCurrent = (): void => {
    const s = get()
    const meta = s.sessions.find((m) => m.id === s.currentSessionId)
    if (!meta || s.messages.length === 0) return
    const record: PersistedSession = {
      id: meta.id,
      title: meta.title,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      workspaceId: meta.cwd ?? null,
      messages: s.messages,
      history: reconstructHistory(s.messages),
      tasks: s.tasks,
      replacementRecords: extractContentReplacementRecords(s.messages),
      tokenUsage: s.lastTokenUsage
    }
    void window.lc.aiSaveSession(record)
  }

  
  const persistSessionById = (sessionId: string): void => {
    const s = get()
    const meta = s.sessions.find((m) => m.id === sessionId)
    if (!meta) return
    const messages = sessionId === s.currentSessionId ? s.messages : s.sessionMessages[sessionId]
    if (!messages || messages.length === 0) return
    const tasks = sessionId === s.currentSessionId ? s.tasks : s.sessionTasks[sessionId] ?? []
    const tokenUsage =
      sessionId === s.currentSessionId ? s.lastTokenUsage : s.sessionTokenUsage[sessionId] ?? null
    const record: PersistedSession = {
      id: meta.id,
      title: meta.title,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      workspaceId: meta.cwd ?? null,
      messages,
      history: reconstructHistory(messages),
      tasks,
      replacementRecords: extractContentReplacementRecords(messages),
      tokenUsage
    }
    void window.lc.aiSaveSession(record)
  }


  const dispatchTurn = async (
    text: string,
    options?: {
      attachments?: ContextAttachment[]
      images?: ImageAttachment[]
      resendOfTurnId?: string
      addUserBubble?: boolean
      
      turnId?: string
    }
  ): Promise<void> => {
    const turnId = options?.turnId ?? uuid()
    const addUserBubble = options?.addUserBubble !== false
    const sessionId = get().currentSessionId
    turnSessionMap.set(turnId, sessionId)
    set((s) => {
      
      const sessions = s.sessions.map((meta) => {
        if (meta.id !== sessionId) return meta
        const isFirst = addUserBubble && s.messages.every((m) => m.role !== 'user')
        return {
          ...meta,
          title: isFirst && meta.title === DEFAULT_SESSION_TITLE ? deriveTitle(text) : meta.title,
          updatedAt: Date.now()
        }
      })
      return {
        streaming: true,
        currentTurnId: turnId,
        lastUserText: text,
        sessions,
        messages: addUserBubble
          ? [...s.messages, { id: uuid(), role: 'user', content: text, turnId, images: options?.images }]
          : s.messages
      }
    })
    
    if (!hydratedMain.has(sessionId)) {
      hydratedMain.add(sessionId)
      try {
        await window.lc.aiLoadSession(sessionId)
      } catch {
        
      }
    }
    syncEditorDirtyPaths()
    // editorContext.workspaceRoot 与会话 cwd 对齐：纯对话不携带 IDE 工作区，避免泄漏
    const sessionCwd = get().sessions.find((m) => m.id === sessionId)?.cwd ?? null
    const editorContext = {
      ...collectEditorContext(),
      workspaceRoot: sessionCwd ?? undefined
    }
    const att =
      options?.attachments && options.attachments.length > 0
        ? options.attachments.filter(
            (a) =>
              (a.kind === 'file' || a.kind === 'folder' || a.kind === 'rule') &&
              a.path &&
              a.content
          )
        : undefined
    try {
      const ack = await window.lc.aiSend({
        sessionId,
        turnId,
        message: text,
        editorContext,
        sessionCwd,
        permissionMode: get().permissionMode,
        ...(options?.resendOfTurnId ? { resendOfTurnId: options.resendOfTurnId } : {}),
        ...(att && att.length > 0 ? { attachments: att } : {}),
        ...(options?.images && options.images.length > 0 ? { images: options.images } : {})
      })
      if (!ack.ok) {
        set((s) => ({
          streaming: false,
          currentTurnId: null,
          messages: [
            ...s.messages,
            { id: uuid(), role: 'error', content: ack.error ?? '发送失败', errorCode: 'unknown' }
          ]
        }))
      }
    } catch (e) {
      set((s) => ({
        streaming: false,
        currentTurnId: null,
        messages: [
          ...s.messages,
          {
            id: uuid(),
            role: 'error',
            content: e instanceof Error ? e.message : '发送失败',
            errorCode: 'unknown'
          }
        ]
      }))
    }
  }

  // —— 流式事件批处理 ——
  // Provider 每吐一小段文本就会产生一个 delta 事件，逐个 set() 会让 React 在
  // 流式期间按 token 频率全量重渲染。这里用 rAF 把一帧内到达的事件合并成单次
  // set()，把渲染频率从“每 token”降到“每帧”，是降低流式 CPU 的核心手段。
  const eventQueue: AgentEvent[] = []
  let flushScheduled = false

  const scheduleFlush = (): void => {
    if (flushScheduled) return
    flushScheduled = true
    const run = (): void => {
      flushScheduled = false
      flushEvents()
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
    else setTimeout(run, 16)
  }

  // 将单个事件折叠进“工作态”，返回该事件产生的状态补丁；副作用（inline diff、
  // 持久化）收集到 side 中，待整批 set 完成后统一执行，避免在 set 内做副作用。
  const foldEvent = (
    s: AgentState,
    event: AgentEvent,
    side: { persist: Set<string>; inlineDiff: Array<() => void> }
  ): Partial<AgentState> => {
    const eventTurnId = 'turnId' in event ? ((event as { turnId?: string }).turnId ?? undefined) : undefined

    if (event.type === 'task_list_updated') {
      if (event.sessionId === s.currentSessionId) {
        return {
          tasks: event.tasks,
          sessionTasks: { ...s.sessionTasks, [event.sessionId]: event.tasks }
        }
      }
      return { sessionTasks: { ...s.sessionTasks, [event.sessionId]: event.tasks } }
    }

    if (event.type === 'turn_start' && !turnSessionMap.has(event.turnId)) {
      turnSessionMap.set(event.turnId, s.currentSessionId)
    }
    const owner = eventTurnId ? turnSessionMap.get(eventTurnId) : undefined
    const targetSession = owner ?? s.currentSessionId
    const isActive = targetSession === s.currentSessionId

    let sessionsPatch: Partial<AgentState> | null = null
    if (event.type === 'workspace_root_changed') {
      const ev = event
      sessionsPatch = {
        sessions: s.sessions.map((m) =>
          m.id === targetSession ? { ...m, cwd: ev.workspaceRoot ?? null } : m
        )
      }
    }

    const rt: SessionRuntime = isActive
      ? {
          messages: s.messages,
          streaming: s.streaming,
          turnId: s.currentTurnId,
          assistantId: s.currentAssistantId,
          canRevert: s.canRevert
        }
      : {
          messages: s.sessionMessages[targetSession] ?? [],
          streaming: s.sessionStreaming[targetSession]?.streaming ?? false,
          turnId: s.sessionStreaming[targetSession]?.turnId ?? null,
          assistantId: s.sessionStreaming[targetSession]?.assistantId ?? null,
          canRevert: s.sessionCanRevert[targetSession] ?? false
        }

    const next = reduceSessionEvent(rt, event)

    if (isActive) {
      if (event.type === 'file_change_proposed') {
        const ev = event
        side.inlineDiff.push(() => useInlineDiffStore.getState().proposeDiffFromRaw(ev.path, ev.diff))
      } else if (event.type === 'file_change_applied' || event.type === 'file_change_rejected') {
        const ev = event
        side.inlineDiff.push(() => useInlineDiffStore.getState().clearDiff(ev.path))
      }
    }

    const nextStreamingMap = { ...s.sessionStreaming }
    if (next.streaming) {
      nextStreamingMap[targetSession] = {
        streaming: true,
        turnId: next.turnId,
        assistantId: next.assistantId
      }
    } else {
      delete nextStreamingMap[targetSession]
    }

    const mapPatch: Partial<AgentState> = {
      sessionMessages: { ...s.sessionMessages, [targetSession]: next.messages },
      sessionCanRevert: { ...s.sessionCanRevert, [targetSession]: next.canRevert },
      sessionStreaming: nextStreamingMap,
      ...(event.type === 'turn_end' && event.usage
        ? { sessionTokenUsage: { ...s.sessionTokenUsage, [targetSession]: event.usage } }
        : {})
    }

    let result: Partial<AgentState>
    if (isActive) {
      const attentionPatch = s.sessionAttention[targetSession]
        ? { sessionAttention: (() => { const a = { ...s.sessionAttention }; delete a[targetSession]; return a })() }
        : {}
      result = {
        ...(sessionsPatch ?? {}),
        messages: next.messages,
        streaming: next.streaming,
        currentTurnId: next.turnId,
        currentAssistantId: next.assistantId,
        canRevert: next.canRevert,
        ...(event.type === 'turn_end' ? { lastTokenUsage: event.usage ?? s.lastTokenUsage } : {}),
        ...mapPatch,
        ...attentionPatch
      }
    } else {
      const needsAttention = hasPendingAttention(next.messages)
      const wasAttention = !!s.sessionAttention[targetSession]
      const attentionPatch =
        needsAttention !== wasAttention
          ? { sessionAttention: { ...s.sessionAttention, [targetSession]: needsAttention } }
          : {}
      result = { ...(sessionsPatch ?? {}), ...mapPatch, ...attentionPatch }
    }

    if (event.type === 'turn_end' || event.type === 'error') {
      if (eventTurnId) turnSessionMap.delete(eventTurnId)
      side.persist.add(targetSession)
    }

    return result
  }

  function flushEvents(): void {
    if (eventQueue.length === 0) return
    const events = eventQueue.splice(0, eventQueue.length)
    const side = { persist: new Set<string>(), inlineDiff: [] as Array<() => void> }
    set((s) => {
      let working = s
      let patch: Partial<AgentState> = {}
      for (const event of events) {
        const p = foldEvent(working, event, side)
        working = { ...working, ...p }
        patch = { ...patch, ...p }
      }
      return patch
    })
    for (const op of side.inlineDiff) op()
    for (const id of side.persist) persistSessionById(id)
  }

  const initialSessionId = 'default'

  return {
    messages: [],
    sessions: [
      {
        id: initialSessionId,
        title: DEFAULT_SESSION_TITLE,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        cwd: null
      }
    ],
    currentSessionId: initialSessionId,
    currentWorkspaceId: null,
    openTabs: [initialSessionId],
    sessionMessages: {},
    sessionCanRevert: {},
    tasks: [],
    sessionTasks: {},
    permissionMode: initialPreferences.permissionMode,
    streaming: false,
    currentTurnId: null,
    currentAssistantId: null,
    sessionStreaming: {},
    sessionAttention: {},
    canRevert: false,
    activeProfile: null,
    lastTokenUsage: null,
    sessionTokenUsage: {},
    lastUserText: null,
    initialized: false,

    init: () => {
      if (get().initialized) return
      set({ initialized: true })
      window.lc.onAiEvent((event) => get().applyEvent(event))
      syncEditorDirtyPaths()
      void get().refreshActiveProfile()
      const ws = useWorkspaceStore.getState().workspace?.path ?? null
      set({ currentWorkspaceId: ws })
      void get().loadAllSessions()
    },

    loadSessions: async () => {
      await get().loadAllSessions()
    },

    setWorkspace: async (workspaceId) => {

      set({ currentWorkspaceId: workspaceId ?? null })
    },

    loadAllSessions: async () => {

      if (get().streaming) return

      turnSessionMap.clear()
      persistCurrent()


      const startEmptySession = (): void => {
        const id = uuid()
        hydratedMain.add(id)
        set({
          sessions: [
            {
              id,
              title: DEFAULT_SESSION_TITLE,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              cwd: get().currentWorkspaceId
            }
          ],
          openTabs: [id],
          currentSessionId: id,
          sessionMessages: {},
          sessionCanRevert: {},
          sessionTasks: {},
          sessionStreaming: {},
          sessionAttention: {},
          sessionTokenUsage: {},
          messages: [],
          tasks: [],
          canRevert: false,
          streaming: false,
          currentTurnId: null,
          currentAssistantId: null,
          lastTokenUsage: null,
          lastUserText: null
        })
      }

      let persisted: PersistedSession[] = []
      try {

        persisted = await window.lc.aiListSessions()
      } catch {
        persisted = []
      }

      if (!persisted.length) {

        startEmptySession()
        return
      }

      const sessions: SessionMeta[] = persisted.map((p) => ({
        id: p.id,
        title: p.title,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        cwd: p.workspaceId ?? null
      }))
      const sessionMessages: Record<string, ChatMessageView[]> = {}
      const sessionTasks: Record<string, AgentTask[]> = {}
      const sessionTokenUsage: Record<string, TokenUsage | null> = {}
      for (const p of persisted) {
        sessionMessages[p.id] = (p.messages as ChatMessageView[]) ?? []
        sessionTasks[p.id] = p.tasks ?? []
        sessionTokenUsage[p.id] = p.tokenUsage ?? null
      }
      const top = sessions[0]
      
      for (const id of [...hydratedMain]) {
        if (id !== 'default') hydratedMain.delete(id)
      }
      set({
        sessions,
        sessionMessages,
        sessionCanRevert: {},
        sessionTasks,
        sessionStreaming: {},
        sessionAttention: {},
        sessionTokenUsage,
        openTabs: [top.id],
        currentSessionId: top.id,
        messages: sessionMessages[top.id] ?? [],
        tasks: sessionTasks[top.id] ?? [],
        canRevert: false,
        streaming: false,
        currentTurnId: null,
        currentAssistantId: null,
        lastTokenUsage: sessionTokenUsage[top.id] ?? null,
        lastUserText: null
      })
    },

    newSession: (cwd) => {
      const id = uuid()
      hydratedMain.add(id)
      set((s) => {
        const stashed = stashCurrentSessionState(s)
        return {
          ...stashed,
          sessions: [
            ...s.sessions,
            {
              id,
              title: DEFAULT_SESSION_TITLE,
              createdAt: Date.now(),
              updatedAt: Date.now(),

              cwd: cwd === undefined ? s.currentWorkspaceId : cwd
            }
          ],
          openTabs: [...s.openTabs.filter((t) => t !== id), id],
          currentSessionId: id,
          messages: [],
          tasks: [],
          streaming: false,
          currentTurnId: null,
          currentAssistantId: null,
          canRevert: false,
          lastTokenUsage: null,
          lastUserText: null
        }
      })
    },

    switchSession: (id) => {
      const s = get()
      if (id === s.currentSessionId) return
      if (!s.sessions.some((m) => m.id === id)) return
      const stashed = stashCurrentSessionState(s)
      const openTabs = s.openTabs.includes(id) ? s.openTabs : [...s.openTabs, id]
      const targetMessages = stashed.sessionMessages[id] ?? []
      const targetStreaming = stashed.sessionStreaming[id]
      const sessionAttention = { ...s.sessionAttention }
      delete sessionAttention[id]
      set({
        ...stashed,
        openTabs,
        currentSessionId: id,
        messages: targetMessages,
        tasks: stashed.sessionTasks[id] ?? [],
        canRevert: stashed.sessionCanRevert[id] ?? false,
        streaming: targetStreaming?.streaming ?? false,
        currentTurnId: targetStreaming?.turnId ?? null,
        currentAssistantId: targetStreaming?.assistantId ?? null,
        sessionAttention,
        lastTokenUsage: stashed.sessionTokenUsage[id] ?? null,
        lastUserText: null
      })
    },

    deleteSession: (id) => {
      const s = get()
      const isTargetStreaming = id === s.currentSessionId ? s.streaming : !!s.sessionStreaming[id]?.streaming
      if (isTargetStreaming) return
      if (!s.sessions.some((m) => m.id === id)) return

      const stashed = stashCurrentSessionState(s)
      const remainingSessions = s.sessions.filter((m) => m.id !== id)
      const remainingTabs = s.openTabs.filter((tabId) => tabId !== id)
      void window.lc.aiDeleteSession(id)

      const nextSessionMessages = { ...stashed.sessionMessages }
      delete nextSessionMessages[id]
      const nextCanRevert = { ...stashed.sessionCanRevert }
      delete nextCanRevert[id]
      const nextSessionTasks = { ...stashed.sessionTasks }
      delete nextSessionTasks[id]
      const nextSessionStreaming = { ...stashed.sessionStreaming }
      delete nextSessionStreaming[id]
      const nextSessionTokenUsage = { ...stashed.sessionTokenUsage }
      delete nextSessionTokenUsage[id]
      const nextAttention = { ...s.sessionAttention }
      delete nextAttention[id]

      if (id !== s.currentSessionId) {
        set({
          sessions: remainingSessions,
          openTabs: remainingTabs,
          sessionMessages: nextSessionMessages,
          sessionCanRevert: nextCanRevert,
          sessionTasks: nextSessionTasks,
          sessionStreaming: nextSessionStreaming,
          sessionTokenUsage: nextSessionTokenUsage,
          sessionAttention: nextAttention
        })
        return
      }

      if (remainingTabs.length === 0) {
        set({
          sessions: remainingSessions,
          openTabs: [],
          currentSessionId: '',
          sessionMessages: nextSessionMessages,
          sessionCanRevert: nextCanRevert,
          sessionTasks: nextSessionTasks,
          sessionStreaming: nextSessionStreaming,
          sessionTokenUsage: nextSessionTokenUsage,
          sessionAttention: nextAttention,
          messages: [],
          tasks: [],
          canRevert: false,
          streaming: false,
          currentTurnId: null,
          currentAssistantId: null,
          lastTokenUsage: null,
          lastUserText: null
        })
        return
      }

      const deletedTabIndex = s.openTabs.indexOf(id)
      const nextId = remainingTabs[Math.min(Math.max(deletedTabIndex, 0), remainingTabs.length - 1)]
      const nextStreamingInfo = nextSessionStreaming[nextId]
      const attentionAfter = { ...nextAttention }
      delete attentionAfter[nextId]
      set({
        sessions: remainingSessions,
        openTabs: remainingTabs,
        currentSessionId: nextId,
        messages: nextSessionMessages[nextId] ?? [],
        tasks: nextSessionTasks[nextId] ?? [],
        canRevert: nextCanRevert[nextId] ?? false,
        sessionMessages: nextSessionMessages,
        sessionCanRevert: nextCanRevert,
        sessionTasks: nextSessionTasks,
        sessionStreaming: nextSessionStreaming,
        sessionTokenUsage: nextSessionTokenUsage,
        sessionAttention: attentionAfter,
        streaming: nextStreamingInfo?.streaming ?? false,
        currentTurnId: nextStreamingInfo?.turnId ?? null,
        currentAssistantId: nextStreamingInfo?.assistantId ?? null,
        lastTokenUsage: nextSessionTokenUsage[nextId] ?? null,
        lastUserText: null
      })
    },

    openSessionTab: (id) => {
      const s = get()
      if (!s.sessions.some((m) => m.id === id)) return
      if (s.openTabs.includes(id)) return
      set({ openTabs: [...s.openTabs, id] })
    },

    closeSessionTab: (id) => {
      const s = get()
      const isTabStreaming = id === s.currentSessionId ? s.streaming : !!s.sessionStreaming[id]?.streaming
      if (isTabStreaming) return
      if (!s.openTabs.includes(id)) return

      const stashed = stashCurrentSessionState(s)
      const remaining = s.openTabs.filter((t) => t !== id)
      if (remaining.length === 0) {
        set({
          ...stashed,
          openTabs: [],
          currentSessionId: '',
          messages: [],
          tasks: [],
          canRevert: false,
          streaming: false,
          currentTurnId: null,
          currentAssistantId: null,
          lastTokenUsage: null,
          lastUserText: null
        })
        return
      }
      if (id === s.currentSessionId) {
        const idx = s.openTabs.indexOf(id)
        const nextId = remaining[Math.min(idx, remaining.length - 1)]
        const nextStreamingInfo = stashed.sessionStreaming[nextId]
        const sessionAttention = { ...s.sessionAttention }
        delete sessionAttention[nextId]
        set({
          ...stashed,
          openTabs: remaining,
          currentSessionId: nextId,
          messages: stashed.sessionMessages[nextId] ?? [],
          tasks: stashed.sessionTasks[nextId] ?? [],
          canRevert: stashed.sessionCanRevert[nextId] ?? false,
          sessionAttention,
          streaming: nextStreamingInfo?.streaming ?? false,
          currentTurnId: nextStreamingInfo?.turnId ?? null,
          currentAssistantId: nextStreamingInfo?.assistantId ?? null,
          lastTokenUsage: stashed.sessionTokenUsage[nextId] ?? null,
          lastUserText: null
        })
      } else {
        set({ openTabs: remaining })
      }
    },

    setPermissionMode: (m) => {
      set({ permissionMode: m })
      saveAgentPreferences({ permissionMode: m })
    },

    revert: async () => {
      if (!get().canRevert) return
      set({ canRevert: false })
      try {
        const { reverted } = await window.lc.aiRevertCheckpoint(get().currentSessionId)
        if (reverted > 0) {
          set((s) => ({
            messages: [
              ...s.messages,
              {
                id: uuid(),
                role: 'assistant',
                content: `已撤销 AI 对 ${reverted} 个文件的修改。`
              }
            ]
          }))
        }
      } catch {
        set({ canRevert: true })
      }
    },

    refreshActiveProfile: async () => {
      try {
        const profile = await window.lc.aiGetActiveProfile()
        set({ activeProfile: profile })
      } catch {
        set({ activeProfile: null })
      }
    },

    sendMessage: async (text, attachments, images) => {
      const trimmed = text.trim()
      if ((!trimmed && !(images && images.length > 0)) || get().streaming) return
      if (!get().currentSessionId) return
      await dispatchTurn(trimmed, { attachments, images, addUserBubble: true })
    },

    regenerate: async (assistantMessageId) => {
      if (get().streaming) return
      const s = get()
      const idx = s.messages.findIndex((m) => m.id === assistantMessageId)
      if (idx < 0) return
      const target = s.messages[idx]
      if (target.role !== 'assistant' || !target.turnId) return
      const turnId = target.turnId
      const userMsg = [...s.messages]
        .slice(0, idx)
        .reverse()
        .find((m) => m.role === 'user' && m.turnId === turnId)
      if (!userMsg?.content.trim()) return
      set({ messages: s.messages.slice(0, idx) })
      
      await dispatchTurn(userMsg.content.trim(), {
        resendOfTurnId: turnId,
        addUserBubble: false,
        turnId
      })
    },

    editAndResend: async (userMessageId, newText) => {
      const trimmed = newText.trim()
      if (!trimmed || get().streaming) return
      const s = get()
      const idx = s.messages.findIndex((m) => m.id === userMessageId)
      if (idx < 0) return
      const target = s.messages[idx]
      if (target.role !== 'user' || !target.turnId) return
      set({
        messages: [...s.messages.slice(0, idx), { ...target, content: trimmed }]
      })
      
      await dispatchTurn(trimmed, {
        resendOfTurnId: target.turnId,
        addUserBubble: false,
        turnId: target.turnId
      })
    },

    stop: () => {
      if (!get().streaming) return
      set((s) => ({
        messages: s.messages
          .filter((m) => !(m.role === 'filechange' && m.fileStatus === 'streaming'))
          .map((m) => {
            if (m.role === 'permission' && m.permissionStatus === 'pending') {
              return { ...m, permissionStatus: 'deny' as const }
            }
            if (m.role === 'question' && m.questionStatus === 'pending') {
              return { ...m, questionStatus: 'cancelled' as const }
            }
            if (m.role === 'filechange' && m.fileStatus === 'proposed') {
              return { ...m, fileStatus: 'rejected' as const }
            }
            return m
          })
      }))
      void window.lc.aiStop(get().currentSessionId)
    },

    retry: () => {
      const text = get().lastUserText
      if (!text || get().streaming) return
      
      set((s) => {
        const msgs = [...s.messages]
        while (msgs.length > 0 && msgs[msgs.length - 1].role === 'error') msgs.pop()
        return { messages: msgs }
      })
      void dispatchTurn(text, { addUserBubble: false })
    },

    clear: () => {
      set((s) => ({
        messages: [],
        tasks: [],
        lastUserText: null,
        lastTokenUsage: null,
        sessionTokenUsage: { ...s.sessionTokenUsage, [s.currentSessionId]: null }
      }))
      void window.lc.aiClearHistory(get().currentSessionId)
    },

    respondPermission: (requestId, decision) => {
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === requestId
            ? { ...m, permissionStatus: decision === 'deny' ? 'deny' : 'allow' }
            : m
        )
      }))
      void window.lc.aiPermissionResponse(get().currentSessionId, requestId, decision)
    },

    respondUserQuestion: (requestId, response) => {
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === requestId
            ? {
                ...m,
                questionStatus: response.cancelled ? ('cancelled' as const) : ('answered' as const),
                questionAnswer: response.answer
              }
            : m
        )
      }))
      void window.lc.aiUserQuestionResponse(get().currentSessionId, requestId, response)
    },

    respondFileChange: (changeId, decision) => {
      syncEditorDirtyPaths()
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === changeId && m.fileStatus === 'proposed'
            ? {
                ...m,
                fileStatus: decision === 'accept' ? ('applied' as const) : ('rejected' as const)
              }
            : m
        )
      }))
      void window.lc.aiFileChangeResponse(get().currentSessionId, changeId, decision)
    },

    revertFileChange: async (changeId) => {
      if (fileChangeInFlight.has(changeId)) return
      const target = get().messages.find((m) => m.id === changeId && m.fileStatus === 'applied')
      if (!target) return
      syncEditorDirtyPaths()
      const setStatus = (status: 'applied' | 'reverted'): void => {
        set((s) => ({
          messages: s.messages.map((m) => (m.id === changeId ? { ...m, fileStatus: status } : m))
        }))
      }
      fileChangeInFlight.add(changeId)
      setStatus('reverted')
      try {
        const { ok, reason } = await window.lc.aiRevertFileChange(get().currentSessionId, changeId)
        if (!ok) {
          setStatus('applied')
          toast.warn(revertFailMessage(reason))
        }
      } catch {
        setStatus('applied')
        toast.error('撤销失败，请重试')
      } finally {
        fileChangeInFlight.delete(changeId)
      }
    },

    redoFileChange: async (changeId) => {
      if (fileChangeInFlight.has(changeId)) return
      const target = get().messages.find((m) => m.id === changeId && m.fileStatus === 'reverted')
      if (!target) return
      syncEditorDirtyPaths()
      const setStatus = (status: 'applied' | 'reverted'): void => {
        set((s) => ({
          messages: s.messages.map((m) => (m.id === changeId ? { ...m, fileStatus: status } : m))
        }))
      }
      fileChangeInFlight.add(changeId)
      setStatus('applied')
      try {
        const { ok, reason } = await window.lc.aiRedoFileChange(get().currentSessionId, changeId)
        if (!ok) {
          setStatus('reverted')
          toast.warn(revertFailMessage(reason))
        }
      } catch {
        setStatus('reverted')
        toast.error('操作失败，请重试')
      } finally {
        fileChangeInFlight.delete(changeId)
      }
    },

    handBackSubagent: (subagentId) => {
      const s = get()
      if (s.streaming) return
      const msg = s.messages.find((m) => m.role === 'subagent' && m.subagent?.id === subagentId)
      const sub = msg?.subagent
      if (!sub || sub.handedBack) return
      
      set((cur) => ({
        messages: cur.messages.map((m) =>
          m.role === 'subagent' && m.subagent?.id === subagentId
            ? { ...m, subagent: { ...m.subagent, handedBack: true } }
            : m
        )
      }))
      const prompt = [
        `后台子 Agent「${sub.title}」已完成。请基于它的执行结果继续：`,
        `（使用 run_subagent 的 resumeSubagentId="${subagentId}" 可获取完整记录）`
      ].join('\n')
      void get().sendMessage(prompt)
    },

    applyEvent: (event) => {
      // 入队 + rAF 批处理：一帧内到达的多个事件合并为一次 set()，把流式期间的
      // 渲染频率从“每 token”降到“每帧”。turn_end/error 这类终结事件也走同一队列，
      // 顺序得到保留，最多延迟一帧，不影响正确性。
      eventQueue.push(event)
      scheduleFlush()
    }
  }
})
