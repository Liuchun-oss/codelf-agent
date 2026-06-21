
export type ContextSegmentId =
  
  | 'systemPrompt'
  
  | 'modeGuidance'
  | 'toolDefinitions'
  | 'mcp'
  | 'rules'
  | 'git'
  | 'environment'
  | 'attachments'
  | 'conversation'
  | 'userMessage'

export interface ContextUsageSegment {
  id: ContextSegmentId
  label: string
  tokens: number
  
  color: string
}

export interface ContextUsageBreakdown {
  segments: ContextUsageSegment[]
  totalTokens: number
  contextWindow: number
  percentFull: number
}

export const CONTEXT_SEGMENT_META: Record<
  ContextSegmentId,
  { label: string; color: string }
> = {
  systemPrompt: { label: '系统提示', color: '#6b7280' },
  modeGuidance: { label: '模式与规范', color: '#94a3b8' },
  toolDefinitions: { label: '工具定义', color: '#8b5cf6' },
  mcp: { label: 'MCP（工具与结果）', color: '#ec4899' },
  rules: { label: '规则', color: '#22c55e' },
  git: { label: 'Git 快照', color: '#14b8a6' },
  environment: { label: '环境信息', color: '#f59e0b' },
  attachments: { label: '附件上下文', color: '#06b6d4' },
  conversation: { label: '历史对话', color: '#3b82f6' },
  userMessage: { label: '当前消息', color: '#64748b' }
}


export function segmentSharePercent(tokens: number, totalTokens: number): number {
  if (totalTokens <= 0) return 0
  return Math.round((tokens / totalTokens) * 100)
}


export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}
