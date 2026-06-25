












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
}

export interface ContentReplacementRecord {
  kind: 'tool-result'
  toolUseId: string
  
  replacement?: string
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
  messages: unknown[]
  history: PersistedChatMessage[]
  tasks?: AgentTask[]
  replacementRecords?: ContentReplacementRecord[]
  discoveredDeferredTools?: string[]
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
}


export interface ImageAttachment {
  dataUrl: string
  
  name?: string
}
