












export type AgentErrorCode =
  | 'provider_auth'
  | 'provider_not_found'
  | 'provider_rate_limit'
  | 'provider_server'
  | 'provider_timeout'
  | 'network'
  | 'no_profile'
  | 'no_workspace'
  | 'tools_not_supported'
  | 'turn_limit'
  | 'denial_limit'
  | 'hook_blocked'
  | 'cancelled'
  | 'unknown'

import type { ContextUsageBreakdown } from './contextUsage'
import type { RoomContext } from './roomTypes'

export interface TokenUsage {
  
  inputTokens: number
  
  outputTokens: number
  estimatedCost?: number
  
  estimatedPromptTokens?: number
  
  estimatedOutputTokens?: number
  
  apiInputTokens?: number
  apiOutputTokens?: number
  
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  
  promptCacheHitRate?: number
  
  promptCacheStatus?: 'unsupported' | 'cold' | 'warming' | 'hit' | 'possibly_broken'
  
  promptCacheProvider?: 'anthropic' | 'openai' | 'deepseek'
  
  promptCacheStrategy?: 'anthropic_cache_control' | 'openai_prompt_cache_key' | 'deepseek_disk_cache'
  
  promptCacheLikelyBroken?: boolean
  
  contextBreakdown?: ContextUsageBreakdown
}

// 逐轮 token 用量日志的单条记录（追加写入 usage-log.jsonl）
export interface UsageLogEntry {
  ts: number
  profileId: string
  model: string
  kind: ProviderKind
  inputTokens: number
  outputTokens: number
  apiInputTokens?: number
  apiOutputTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  sessionId?: string
  turnId?: string
}

// 用量统计查询条件（时间窗口为毫秒时间戳，闭区间）
export interface UsageStatsQuery {
  from?: number
  to?: number
  profileId?: string
}

// 单个模型配置的用量聚合行
export interface UsageStatsProfileRow {
  profileId: string
  // 展示名：由 handler 关联当前配置补全，配置已删则缺省
  name?: string
  model: string
  kind: ProviderKind
  inputTokens: number
  outputTokens: number
  totalTokens: number
  turns: number
}

export interface UsageStatsResult {
  perProfile: UsageStatsProfileRow[]
  total: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    turns: number
  }
}





export type AgentTaskStatus = 'pending' | 'in_progress' | 'completed'

export interface AgentTask {
  id: string
  subject: string
  description: string
  activeForm?: string
  status: AgentTaskStatus
  createdAt: number
  updatedAt: number
}

export interface AgentTaskSummary {
  id: string
  subject: string
  status: AgentTaskStatus
  activeForm?: string
  updatedAt: number
}






export interface PermissionDetails {
  command?: string
  path?: string
  diff?: string
}


export type AgentEvent =
  | { type: 'turn_start'; turnId: string; profileId: string }
  | { type: 'context_estimate'; turnId: string; usage: TokenUsage }
  | { type: 'turn_end'; turnId: string; usage?: TokenUsage }
  | { type: 'workspace_root_changed'; turnId: string; workspaceRoot: string | null; reason?: string }
  | { type: 'text_delta'; turnId: string; content: string }
  | { type: 'thinking_delta'; turnId: string; content: string }
  | {
      // 模型生成图片的流式中间预览（base64 data URL）。前端按 index 覆盖渲染。
      type: 'image_progress'
      turnId: string
      index: number
      dataUrl: string
    }
  | {
      type: 'tool_call_start'
      turnId: string
      callId: string
      name: string
      args: Record<string, unknown>
    }
  | {
      type: 'tool_call_delta'
      turnId: string
      callId: string
      name?: string
      argsText: string
      argsDelta?: string
    }
  | {
      type: 'tool_call_progress'
      turnId: string
      callId: string
      message: string
      status?: 'queued' | 'running' | 'waiting' | 'completed' | 'error'
      
      backgroundId?: string
      deferredId?: string
      
      chunk?: string
    }
  | {
      type: 'subagent_start'
      turnId: string
      subagentId: string
      callId: string
      description: string
      task: string

      background?: boolean

      subagentType?: string

      readOnly?: boolean

      model?: string
    }
  | {
      type: 'subagent_delta'
      turnId: string
      subagentId: string
      content: string
    }
  | {
      type: 'subagent_tool_start'
      turnId: string
      subagentId: string
      callId: string
      name: string
      args: Record<string, unknown>
    }
  | {
      type: 'subagent_tool_result'
      turnId: string
      subagentId: string
      callId: string
      result: string
      isError?: boolean
      truncated?: boolean
      durationMs?: number
      
      filePath?: string
      fileDiff?: string
      isCreate?: boolean
    }
  | {
      type: 'subagent_end'
      turnId: string
      subagentId: string
      callId: string
      status: 'completed' | 'error'
      finalText: string
      usage?: TokenUsage
      durationMs?: number
      failureSummary?: string
      
      background?: boolean
    }
  | {
      type: 'tool_call_result'
      turnId: string
      callId: string
      result: string
      truncated?: boolean
      durationMs?: number
      
      isError?: boolean
      deferred?: boolean
      
      backgroundId?: string
      deferredId?: string
      status?: 'pending' | 'completed' | 'error'
    }
  | {
      type: 'permission_request'
      turnId: string
      requestId: string
      tool: string
      summary: string
      details?: PermissionDetails
    }
  | {
      type: 'user_question'
      turnId: string
      requestId: string
      question: string
      suggestions?: string[]
      structuredQuestions?: AskUserQuestionItem[]
      
      previewImageId?: string
    }
  | {
      type: 'user_question_resolved'
      turnId: string
      requestId: string
      answer: string
      answers?: Record<string, string>
      annotations?: AskUserQuestionAnnotations
      cancelled?: boolean
    }
  | {
      type: 'permission_resolved'
      turnId: string
      requestId: string
      decision: 'allow' | 'deny'
    }
  | {
      type: 'file_change_proposed'
      turnId: string
      changeId: string
      callId?: string
      path: string
      diff: string
    }
  | { type: 'file_change_applied'; turnId: string; changeId?: string; path: string }
  | { type: 'file_change_rejected'; turnId: string; path: string }
  | { type: 'checkpoint_created'; turnId: string; checkpointId: string; files: string[] }
  | {
      type: 'task_list_updated'
      turnId: string
      sessionId: string
      tasks: AgentTask[]
      changedTaskId?: string
    }
  | {
      type: 'error'
      turnId: string
      code: AgentErrorCode
      message: string
      httpStatus?: number
      retryable: boolean
    }
  | { type: 'warning'; turnId: string; message: string }
  
  | { type: 'notice'; turnId: string; message: string }


export type AgentEventType = AgentEvent['type']


export type PermissionDecision = 'allow_once' | 'allow_session' | 'allow_project' | 'deny'


export type FileChangeDecision = 'accept' | 'reject'

export interface AskUserQuestionOption {
  label: string
  description: string
  preview?: string
}

export interface AskUserQuestionItem {
  question: string
  header: string
  options: AskUserQuestionOption[]
  multiSelect?: boolean
}

export type AskUserQuestionAnnotations = Record<string, { preview?: string; notes?: string }>


export interface UserQuestionResponse {
  answer: string
  answers?: Record<string, string>
  annotations?: AskUserQuestionAnnotations
  cancelled?: boolean
}

export interface PermissionResponse {
  turnId: string
  requestId: string
  decision: PermissionDecision
}





export type ProviderKind =
  | 'openai'
  | 'azure-openai'
  | 'anthropic'
  | 'openai-compatible'
  | 'deepseek'
  | 'dify' 


export type MetadataSource = 'manual' | 'auto' | 'default'

export interface ProviderProfile {
  id: string
  name: string
  kind: ProviderKind
  baseUrl: string
  
  apiKeyRef: string
  model: string

  
  contextWindow?: number
  contextWindowSource: MetadataSource
  maxOutputTokens?: number
  maxOutputTokensSource: MetadataSource

  
  supportsTools: boolean
  supportsVision?: boolean
  supportsReasoning?: boolean
  
  thinkingMode?: 'enabled' | 'disabled'
  reasoningEffort?: 'high' | 'max'
  
  fimEnabled?: boolean

  // 启用后该 Provider 改走 OpenAI Responses API，支持模型在对话中直接生成图片。
  imageGeneration?: boolean

  
  azureDeployment?: string
  azureApiVersion?: string

  timeoutMs: number
  lastTestAt?: string
  lastTestOk?: boolean
  lastTestLatencyMs?: number
}


export interface ProviderProfileSummary extends ProviderProfile {
  hasApiKey: boolean
}


export interface FimRequest {
  prefix: string
  suffix?: string
  maxTokens?: number
}

export interface FimResult {
  ok: boolean
  text?: string
  error?: string
}

export interface InlineEditRequest {
  
  instruction: string
  
  selection: string
  
  language: string
  
  filePath?: string
  
  prefix?: string
  
  suffix?: string
}

export interface InlineEditResult {
  ok: boolean
  
  text?: string
  error?: string
}

export interface ActiveModelState {
  activeProfileId: string | null
}


export type ProfileDraft = Omit<
  ProviderProfile,
  'apiKeyRef' | 'lastTestAt' | 'lastTestOk' | 'lastTestLatencyMs'
> & {
  apiKey?: string
}


export interface AgentOpResult {
  ok: boolean
  error?: string
}






export interface PersistedChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  // 工具调用相关字段必须持久化，否则恢复后历史不合规（assistant 的 tool_calls 丢失、
  // tool 消息变成孤儿），严格的 Provider（如 DeepSeek）会拒绝整个请求。
  toolCalls?: { id: string; name: string; arguments: string }[]
  toolCallId?: string
}

export interface ContentReplacementRecord {
  kind: 'tool-result'
  toolUseId: string
  
  replacement?: string
}

// 可持久化的单个文件变更快照。跨重启保留后，撤销/取消撤销才能继续生效。
// oldData 为写盘前原始字节的 base64；newContent 为 AI 写入的新文本。
export interface PersistedFileChange {
  changeId: string
  path: string
  encoding: 'utf8' | 'utf8bom' | 'utf16le' | 'utf16be' | 'gbk'
  oldExisted: boolean
  oldDataBase64: string
  newContent: string
  state: 'applied' | 'reverted'
}


export interface RuleSummary {
  name: string
  description?: string
  activation: 'always' | 'autoAttached' | 'agentRequested' | 'manual'
  body: string
}


export interface PersistedSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  
  workspaceId?: string | null
  archived?: boolean
  messages: unknown[]
  history: PersistedChatMessage[]
  tasks?: AgentTask[]
  replacementRecords?: ContentReplacementRecord[]
  discoveredDeferredTools?: string[]
  fileChanges?: PersistedFileChange[]
  tokenUsage?: TokenUsage | null
}


export interface SaveProfileResult extends AgentOpResult {
  profile?: ProviderProfileSummary
}


export interface AuditEntry {
  ts: string
  action: 'write' | 'edit' | 'create' | 'delete' | 'terminal'
  tool: string
  sessionId?: string
  turnId?: string
  path?: string
  command?: string
}


export interface DebugEventRecord {
  ts: string
  kind: 'request_start' | 'request_end' | 'request_error' | 'tool_call' | 'compact' | 'memory'
  sessionId?: string
  turnId?: string
  label?: string
  detail?: string
  durationMs?: number
}


export interface TestConnectionResult {
  ok: boolean
  latencyMs?: number
  contextWindow?: number
  maxOutputTokens?: number
  supportsTools?: boolean
  supportsVision?: boolean
  error?: string
  
  balanceAvailable?: boolean
  balanceTotal?: string
  balanceCurrency?: string
}

export interface TestImageGenResult {
  ok: boolean
  error?: string
  latencyMs?: number
  // 生成图片的 data URL（PNG base64），供前端直接预览，不落盘。
  dataUrl?: string
  // 是否在过程中收到过流式中间预览。
  sawPartial?: boolean
}

export interface SubagentTaskSummary {
  id: string
  description: string
  subagentType?: string
  status: 'running' | 'completed' | 'error' | 'cancelled'
  parentSessionId?: string
  finalText?: string
  failureSummary?: string
  durationMs?: number
  updatedAt: number
  model?: string
}

export interface AgentDefinitionSummary {
  id: string
  title: string
  description: string
  source: 'built-in' | 'project'
  readOnly: boolean
  allowedTools?: string[]
  deniedTools: string[]
  path?: string
  model?: string
}





export type ContextAttachmentKind = 'file' | 'folder' | 'selection' | 'terminal' | 'rule'

export interface ContextAttachment {
  kind: ContextAttachmentKind
  
  path?: string
  
  content?: string
  startLine?: number
  endLine?: number
}


export interface EditorContextSnapshot {
  
  workspaceRoot?: string
  activeFilePath?: string
  
  selection?: string
  selectionStartLine?: number
  selectionEndLine?: number
  cursorLine?: number
  cursorCol?: number
  
  dirtyPaths?: string[]
}






export interface AiSendPayload {
  
  sessionId: string
  
  turnId: string
  message: string
  attachments?: ContextAttachment[]
  
  images?: ImageAttachment[]
  
  resendOfTurnId?: string
  editorContext?: EditorContextSnapshot

  permissionMode?: 'default' | 'acceptEdits'

  sessionCwd?: string | null

  /**
   * 指定本轮使用的 Provider profile id。群聊岗位用它实现「每岗位不同模型」（seat.modelProfileId）；
   * 不设则回退到全局激活 profile（getActiveProfileId）。桌面/微信不设 → 行为不变。
   */
  profileId?: string

  /**
   * 记忆读写专用工作区根。仅群聊岗位开启 worktree 隔离时与 sessionCwd 不同：
   * sessionCwd 指向 worktree 副本（隔离文件写），而记忆应绑定岗位的基础 seats/ 路径
   * （长期人格不随临时副本漂移，见策划书 §9.2 决策）。不设则记忆回退用 sessionCwd。
   */
  memoryWorkspaceRoot?: string | null

  /**
   * 微信 agent 人格上下文。仅微信通道的轮次会带上，
   * 用于注入「人格定义」系统提示或触发首次激活引导。
   */
  persona?: {
    activationMode?: boolean
    selfName?: string
    ownerName?: string
    addressing?: string
    style?: string
  }

  /**
   * 群聊岗位上下文。仅群聊编排器调度岗位发言时带上，驱动「岗位身份段 + 群上下文段」
   * （见策划书 §5.4）。纯增量、向后兼容；桌面/微信会话不带 → 行为零变化。
   * 与 persona 互斥：岗位会话用 roomContext，微信会话用 persona。
   */
  roomContext?: RoomContext

  /**
   * 通讯通道上下文。仅经由 IM 通道（如微信）转发进来的轮次会带上。
   * 桌面/UI 会话不带 → 让 agent 感知「自己正被远程用户通过 IM 聊天」，并知道如何发文件。
   * 纯增量、向后兼容。
   */
  channel?: {
    id: string
    label: string
    canSendFile?: boolean
    canSendImage?: boolean
  }
}

export interface ImageAttachment {
  dataUrl: string
  
  name?: string
}
