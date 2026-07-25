import type { ChatMessage, ToolDef } from '../providers'
import type { ProviderKind } from '@shared/agentTypes'
import type { ContextUsageBreakdown, ContextUsageSegment, ContextSegmentId } from '@shared/contextUsage'
import { CONTEXT_SEGMENT_META } from '@shared/contextUsage'
import type { PromptContext } from '../prompts/types'
import { getIntroSection } from '../prompts/sections/intro'
import { getSystemSection } from '../prompts/sections/system'
import { getDoingTasksSection } from '../prompts/sections/doingTasks'
import { getActionsSection } from '../prompts/sections/actions'
import { getUsingToolsSection } from '../prompts/sections/usingTools'
import { getToneAndStyleSection } from '../prompts/sections/toneAndStyle'
import { getLanguageSection, getEnvSection } from '../prompts/sections/language'
import { getWorkingApproachSection } from '../prompts/sections/workingApproach'
import { getProjectLayoutSection } from '../prompts/sections/projectLayout'
import { getMemorySection } from '../prompts/sections/memory'
import { getBehavioralGuidelinesSection } from '../prompts/sections/behavioralGuidelines'
import { getMirrorsSection } from '../prompts/sections/mirrors'
import { collectUserContext, renderUserContext } from '../prompts/context/userContext'
import { collectSystemContext, renderSystemContext } from '../prompts/context/systemContext'
import { countTokens } from './tokenCounter'
import { isMcpToolName } from '../mcp/naming'

function filterEmpty(arr: Array<string | null | undefined>): string[] {
  return arr.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
}

function segment(
  id: ContextSegmentId,
  text: string,
  model: string,
  kind: ProviderKind
): ContextUsageSegment | null {
  const t = text.trim()
  if (!t) return null
  const tokens = countTokens(t, model, kind)
  if (tokens <= 0) return null
  const meta = CONTEXT_SEGMENT_META[id]
  return { id, label: meta.label, tokens, color: meta.color }
}

function toolsPayloadText(toolDefs: ToolDef[]): string {
  if (toolDefs.length === 0) return ''
  return JSON.stringify(toolDefs)
}

// 建立 toolCallId → 工具名 的映射（工具名在 assistant 消息的 toolCalls 里）。
function buildToolCallNameMap(history: ChatMessage[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const m of history) {
    if (m.role === 'assistant' && m.toolCalls) {
      for (const tc of m.toolCalls) map.set(tc.id, tc.name)
    }
  }
  return map
}

function isMcpToolMessage(m: ChatMessage, toolCallNames: Map<string, string>): boolean {
  if (m.role !== 'tool' || !m.toolCallId) return false
  const name = toolCallNames.get(m.toolCallId)
  return name ? isMcpToolName(name) : false
}

function historyText(history: ChatMessage[], toolCallNames: Map<string, string>): string {
  return history
    .filter((m) => !isMcpToolMessage(m, toolCallNames))
    .map((m) => {
      if (m.role === 'tool') return `[tool:${m.toolCallId ?? ''}]\n${m.content}`
      return `[${m.role}]\n${m.content}`
    })
    .join('\n\n')
}

// MCP 工具结果文本（从历史里拆出来单独计数）。
function mcpResultsText(history: ChatMessage[], toolCallNames: Map<string, string>): string {
  return history
    .filter((m) => isMcpToolMessage(m, toolCallNames))
    .map((m) => `[tool:${m.toolCallId ?? ''}]\n${m.content}`)
    .join('\n\n')
}


export function extractAttachmentPrefix(fullUserContent: string, rawMessage: string): string {
  const trimmed = rawMessage.trim()
  if (!trimmed || !fullUserContent.endsWith(trimmed)) return ''
  const prefix = fullUserContent.slice(0, fullUserContent.length - trimmed.length).trim()
  return prefix
}

export interface BuildContextBreakdownInput {
  ctx: PromptContext
  toolDefs: ToolDef[]
  history: ChatMessage[]
  fullUserContent: string
  rawUserMessage: string
  model: string
  kind: ProviderKind
  contextWindow: number
  signal?: AbortSignal
}

export async function buildContextBreakdown(
  input: BuildContextBreakdownInput
): Promise<ContextUsageBreakdown> {
  const { ctx, toolDefs, history, fullUserContent, rawUserMessage, model, kind, contextWindow, signal } =
    input

  const [userSnap, sysSnap] = await Promise.all([
    collectUserContext(ctx),
    collectSystemContext(ctx, signal)
  ])

  
  const coreSystemText = filterEmpty([
    getIntroSection(ctx),
    getSystemSection(ctx),
    getProjectLayoutSection(ctx),
    getMemorySection(ctx)
  ]).join('\n\n')
  const modeGuidanceText = filterEmpty([
    getWorkingApproachSection(ctx),
    getDoingTasksSection(),
    getActionsSection(),
    getUsingToolsSection(ctx),
    getToneAndStyleSection(),
    getBehavioralGuidelinesSection(),
    getMirrorsSection(ctx)
  ]).join('\n\n')

  const envText = filterEmpty([getEnvSection(ctx), getLanguageSection(ctx)]).join('\n\n')
  const rulesText = renderUserContext(userSnap) ?? ''
  const gitText = renderSystemContext(sysSnap) ?? ''
  const attachText = extractAttachmentPrefix(fullUserContent, rawUserMessage)

  // 拆分 MCP 工具定义与其余工具定义，分别计入 mcp 段与 toolDefinitions 段。
  const mcpToolDefs = toolDefs.filter((t) => isMcpToolName(t.name))
  const coreToolDefs = toolDefs.filter((t) => !isMcpToolName(t.name))

  const toolCallNames = buildToolCallNameMap(history)
  // MCP 段 = MCP 工具定义 + MCP 工具结果，合并计数。
  const mcpText = filterEmpty([
    toolsPayloadText(mcpToolDefs),
    mcpResultsText(history, toolCallNames)
  ]).join('\n\n')

  const segments = [
    segment('systemPrompt', coreSystemText, model, kind),
    segment('modeGuidance', modeGuidanceText, model, kind),
    segment('toolDefinitions', toolsPayloadText(coreToolDefs), model, kind),
    segment('mcp', mcpText, model, kind),
    segment('rules', rulesText, model, kind),
    segment('git', gitText, model, kind),
    segment('environment', envText, model, kind),
    segment('attachments', attachText, model, kind),
    segment('conversation', historyText(history, toolCallNames), model, kind),
    segment('userMessage', rawUserMessage.trim(), model, kind)
  ].filter((s): s is ContextUsageSegment => s != null)

  const totalTokens = segments.reduce((sum, s) => sum + s.tokens, 0)
  const window = contextWindow > 0 ? contextWindow : 500_000
  const percentFull = Math.min(100, Math.round((totalTokens / window) * 100))

  return { segments, totalTokens, contextWindow: window, percentFull }
}
