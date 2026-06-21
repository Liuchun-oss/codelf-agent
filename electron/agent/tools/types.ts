import type { AgentEvent, UserQuestionResponse } from '@shared/agentTypes'
import type { ChatMessage } from '../providers'
import type { ContentReplacementState } from './resultStorage'
import type { z } from 'zod'

export interface SnipHistoryRequest {
  reason: string
  turnIds?: string[]
  beforeTurnId?: string
  keepRecentTurns?: number
}


export interface ToolContext {
  
  workspaceRoot: string | null
  
  sessionId?: string
  
  signal?: AbortSignal
  
  permissionMode?: 'default' | 'acceptEdits'
  
  snapshot?: (absPath: string) => Promise<void>
  
  emitEvent?: (event: AgentEvent) => void
  
  turnId?: string
  
  toolCallId?: string
  
  parentMessages?: ChatMessage[]
  
  contentReplacementState?: ContentReplacementState
  
  requestSnipHistory?: (request: SnipHistoryRequest) => Promise<ToolResult>
  
  requestWorkspaceRootChange?: (workspaceRoot: string | null, reason?: string) => void
  
  inspectContext?: () => ToolResult
  
  requestUserQuestion?: (
    question: string,
    suggestions?: string[],
    options?: { previewImageId?: string }
  ) => Promise<UserQuestionResponse>
}


export interface FileChangeProposal {
  
  path: string
  newContent: string
  encoding: import('../../services/fsService').FileEncoding
  
  diff: string
  
  isCreate: boolean
}


export interface ToolResult {
  content: string
  isError?: boolean
  truncated?: boolean
  deferred?: boolean
  backgroundId?: string
  deferredId?: string
  pending?: boolean
  
  fileChange?: FileChangeProposal
  
  appliedPath?: string
  // 工具产出的图片（如 MCP 截图工具）。data URL 形式，供多模态模型读取。
  images?: { dataUrl: string }[]
}


export interface Tool<I = unknown> {
  name: string
  
  description: string
  schema: z.ZodType<I>
  // MCP 等外部工具直接提供 JSON Schema，无法用 zod 表达。
  // 设置后，注册表生成工具定义时优先使用它，而非由 schema 转换。
  rawInputSchema?: Record<string, unknown>
  readOnly: boolean
  concurrencySafe: boolean
  destructive?: boolean
  
  deferred?: boolean
  
  permissionGroup?: string
  
  alwaysLoad?: boolean
  
  supportsBackgroundExecution?: boolean
  
  producesFileChange?: boolean
  execute(input: I, ctx: ToolContext): Promise<ToolResult>
}
