import { z } from 'zod'
import type { AgentBehaviorSettings } from '@shared/agentSettings'
import type { ToolDef } from '../providers'
import type { Tool, ToolContext, ToolResult } from './types'
import {
  readFileTool,
  listDirTool,
  writeFileTool,
  editFileTool,
  deleteFileTool
} from './fileTools'
import { multiEditTool } from './multiEditTool'
import { grepTool, codebaseSearchTool } from './searchTools'
import { knowledgeSearchTool } from './knowledgeTools'
import { probeStore as probeKnowledgeStore } from '../../services/knowledge/store'
import { globTool } from './globTool'
import { terminalTool } from './terminalTools'
import { powerShellTool } from './powerShellTool'
import { startTerminalTaskTool, readTerminalTaskTool, stopTerminalTaskTool, writeTerminalTaskTool } from './terminalTaskTools'
import { sleepTool } from './sleepTool'
import { webFetchTool } from './webFetchTool'
import { webSearchTool } from './webSearchTool'
import { notebookEditTool } from './notebookEditTool'
import { notebookReadTool } from './notebookReadTool'
import { getDiagnosticsTool } from './lspTools'
import { searchHistoryTool } from './historyTools'
import { listConversationsTool, readConversationTool } from './conversationTools'
import { snipHistoryTool } from './snipHistoryTool'
import { appendNoteTool } from './appendNoteTool'
import { searchMemoryTool } from './searchMemoryTool'
import { askUserTool } from './userTools'
import { askUserQuestionTool } from './askUserQuestionTool'
import { createRunSubagentTool } from '../orchestrator/subagent'
import { taskCreateTool, taskUpdateTool, taskListTool, taskGetTool } from './taskTools'
import { todoWriteTool } from './todoWriteTool'
import { enterWorktreeTool, exitWorktreeTool } from './worktreeTools'
import { contextInspectTool } from './contextTools'
import { createDeferredDiscoveryTools, EXECUTE_EXTRA_TOOL_NAME, SEARCH_EXTRA_TOOLS_NAME, type DeferredToolSummary } from './deferredTools'
import { skillTool, SKILL_TOOL_NAME } from './skillTool'
import { installSkillTool, INSTALL_SKILL_TOOL_NAME } from './installSkillTool'
import { installPluginTool, INSTALL_PLUGIN_TOOL_NAME } from './installPluginTool'
import { reloadMcpServersTool } from './mcpTools'
import { modelConfigTool } from './modelConfigTool'
import { mediaConfigTool } from './mediaConfigTool'
import {
  browserOpenTool,
  browserNavigateTool,
  browserClickTool,
  browserTypeTool,
  browserSnapshotTool,
  browserGetContentTool,
  browserScreenshotTool,
  browserWaitForTool,
  browserHandoffTool,
  browserTabsTool,
  browserCookiesTool,
  browserCloseTool
} from './browserTools'
import { openInAppBrowserTool } from './openInAppBrowserTool'
import { generateImageTool, editImageTool } from './generateImageTool'
import { generateVideoTool } from './generateVideoTool'
import { getVideoTaskTool } from './getVideoTaskTool'
import { generateAudioTool } from './generateAudioTool'
import {
  desktopLaunchAppTool,
  desktopListWindowsTool,
  desktopGetWindowTool,
  desktopSnapshotTool,
  desktopClickTool,
  desktopTypeTool,
  desktopMouseTool,
  desktopMouseMoveTool,
  desktopDragTool,
  desktopScrollTool,
  desktopScreenshotTool,
  desktopWaitForTool,
  desktopHandoffTool,
  desktopCloseAppTool
} from './desktopTools'

const CORE_TOOL_NAMES = new Set<string>([
  SEARCH_EXTRA_TOOLS_NAME,
  EXECUTE_EXTRA_TOOL_NAME,
  'read_file',
  'list_dir',
  'Glob',
  'grep',
  'codebase_search',
  'write_file',
  'edit_file',
  'delete_file',
  'run_terminal_cmd',
  'PowerShell',
  'StartTerminalTask',
  'ReadTerminalTask',
  'StopTerminalTask',
  'WriteTerminalTask',
  'get_diagnostics',
  'search_history',
  'append_note',
  'search_memory',
  'AskUser',
  'AskUserQuestion',
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'run_subagent',
  SKILL_TOOL_NAME,
  INSTALL_SKILL_TOOL_NAME,
  INSTALL_PLUGIN_TOOL_NAME
])

export type DeferredToolPolicy = 'explicit' | 'non-core' | 'auto'

function parseEnvAutoThreshold(): number | undefined {
  const raw = process.env.AGENT_DEFER_EXTRA_TOOLS_THRESHOLD_CHARS
  if (!raw) return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

function getEnvDeferredToolPolicy(): DeferredToolPolicy | undefined {
  const value = process.env.AGENT_DEFER_EXTRA_TOOLS
  if (value === 'non-core') return 'non-core'
  if (value === 'auto') return 'auto'
  if (value === 'explicit') return 'explicit'
  return undefined
}


export class ToolRegistry {
  private tools = new Map<string, Tool<unknown>>()
  private discoveredDeferredTools = new Set<string>()
  private autoDeferredDecision: boolean | undefined
  private policyOverride: DeferredToolPolicy | undefined
  private autoThresholdOverride: number | undefined

  register<I>(tool: Tool<I>): void {
    this.tools.set(tool.name, tool as Tool<unknown>)
    this.autoDeferredDecision = undefined
  }

  // 移除某个工具（用于 MCP 工具在重连/禁用时清理）。
  unregister(name: string): void {
    if (this.tools.delete(name)) {
      this.discoveredDeferredTools.delete(name)
      this.autoDeferredDecision = undefined
    }
  }

  // 移除所有名字匹配前缀的工具（用于按 server 清理 mcp__<server>__*）。
  unregisterByPrefix(prefix: string): void {
    for (const name of [...this.tools.keys()]) {
      if (name.startsWith(prefix)) this.unregister(name)
    }
  }

  get(name: string): Tool<unknown> | undefined {
    return this.tools.get(name)
  }

  all(): Tool<unknown>[] {
    return [...this.tools.values()]
  }

  configureDeferredPolicy(settings: Pick<AgentBehaviorSettings, 'deferredToolPolicy' | 'deferredToolAutoThresholdChars'>): void {
    const beforePolicy = this.getPolicy()
    const beforeThreshold = this.getAutoThreshold()
    this.policyOverride = settings.deferredToolPolicy
    this.autoThresholdOverride = settings.deferredToolAutoThresholdChars
    this.autoDeferredDecision = undefined
    const afterPolicy = this.getPolicy()
    const afterThreshold = this.getAutoThreshold()
    if (beforePolicy !== afterPolicy || (afterPolicy === 'auto' && beforeThreshold !== afterThreshold)) {
      this.clearDiscoveredDeferredTools()
    }
  }

  
  availableTools(): Tool<unknown>[] {
    return this.all()
  }

  coreTools(): Tool<unknown>[] {
    // Discovered deferred tools are intentionally NOT promoted into the advertised
    // tool set: they stay invokable only via ExecuteExtraTool. This keeps the `tools`
    // request field frozen for the whole session so the (large) prompt-cache prefix
    // never invalidates when the model discovers a deferred/MCP tool mid-conversation.
    return this.availableTools().filter((tool) => !this.isDeferredTool(tool) || this.isDiscoveryTool(tool.name))
  }

  deferredTools(): Tool<unknown>[] {
    return this.availableTools().filter((tool) => this.isDeferredTool(tool) && !this.isDiscoveryTool(tool.name))
  }

  listDeferredToolSummaries(): DeferredToolSummary[] {
    return this.deferredTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      readOnly: tool.readOnly,
      concurrencySafe: tool.concurrencySafe,
      destructive: tool.destructive,
      supportsBackgroundExecution: tool.supportsBackgroundExecution,
      schema: schemaForTool(tool)
    }))
  }

  markDeferredToolDiscovered(name: string): boolean {
    const tool = this.tools.get(name)
    if (!tool || !this.isDeferredTool(tool)) return false
    this.discoveredDeferredTools.add(name)
    return true
  }

  isDeferredToolDiscovered(name: string): boolean {
    return this.discoveredDeferredTools.has(name)
  }

  discoveredDeferredToolNames(): string[] {
    return [...this.discoveredDeferredTools].sort()
  }

  restoreDiscoveredDeferredTools(names: readonly string[] | undefined): void {
    this.discoveredDeferredTools.clear()
    for (const name of names ?? []) this.markDeferredToolDiscovered(name)
  }

  undiscoveredDeferredToolSummaries(): DeferredToolSummary[] {
    return this.listDeferredToolSummaries().filter((tool) => !this.discoveredDeferredTools.has(tool.name))
  }

  discoveredDeferredToolSummaries(): DeferredToolSummary[] {
    return this.listDeferredToolSummaries().filter((tool) => this.discoveredDeferredTools.has(tool.name))
  }

  clearDiscoveredDeferredTools(): void {
    this.discoveredDeferredTools.clear()
  }

  private isDiscoveryTool(name: string): boolean {
    return name === SEARCH_EXTRA_TOOLS_NAME || name === EXECUTE_EXTRA_TOOL_NAME
  }

  private isCoreTool(name: string): boolean {
    return CORE_TOOL_NAMES.has(name)
  }

  private getPolicy(): DeferredToolPolicy {
    return this.policyOverride ?? getEnvDeferredToolPolicy() ?? 'explicit'
  }

  private getAutoThreshold(): number {
    return this.autoThresholdOverride ?? parseEnvAutoThreshold() ?? 18_000
  }

  private shouldAutoDeferNonCoreTools(): boolean {
    if (this.autoDeferredDecision !== undefined) return this.autoDeferredDecision
    const threshold = this.getAutoThreshold()
    const size = this.availableTools()
      .filter((tool) => !tool.alwaysLoad && !this.isDiscoveryTool(tool.name) && !this.isCoreTool(tool.name))
      .reduce((total, tool) => total + tool.name.length + tool.description.length + JSON.stringify(schemaForTool(tool)).length, 0)
    this.autoDeferredDecision = size >= threshold
    return this.autoDeferredDecision
  }

  private isDeferredTool(tool: Tool<unknown>): boolean {
    if (tool.alwaysLoad) return false
    if (this.isDiscoveryTool(tool.name)) return false
    if (tool.deferred) return true
    const policy = this.getPolicy()
    if (policy === 'non-core') return !this.isCoreTool(tool.name)
    if (policy === 'auto') return this.shouldAutoDeferNonCoreTools() && !this.isCoreTool(tool.name)
    return false
  }

  
  toToolDefs(): ToolDef[] {
    return this.coreTools().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: schemaForTool(t)
    }))
  }

  
  async run(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) return { content: `未知工具：${name}`, isError: true }
    if (this.isDeferredTool(tool) && !this.discoveredDeferredTools.has(name) && name !== SEARCH_EXTRA_TOOLS_NAME && name !== EXECUTE_EXTRA_TOOL_NAME) {
      return { content: `工具 ${name} 是 deferred tool。请先调用 ${SEARCH_EXTRA_TOOLS_NAME}，使用 query="select:${name}" 发现该工具；然后通过 ${EXECUTE_EXTRA_TOOL_NAME} 执行。`, isError: true }
    }
    const parsed = tool.schema.safeParse(rawInput)
    if (!parsed.success) {
      return { content: `参数无效：${formatZodError(parsed.error)}`, isError: true }
    }
    try {
      return await tool.execute(parsed.data, ctx)
    } catch (e) {
      return { content: e instanceof Error ? e.message : '工具执行失败', isError: true }
    }
  }
}

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>
  delete json.$schema
  return json
}

// 工具的 JSON Schema：外部工具（MCP）优先用其原始 JSON Schema，其余由 zod 转换。
function schemaForTool(tool: Tool<unknown>): Record<string, unknown> {
  if (tool.rawInputSchema) return tool.rawInputSchema
  return toJsonSchema(tool.schema)
}

function formatZodError(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
}


export function buildDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  for (const tool of createDeferredDiscoveryTools({
    listDeferredTools: () => registry.listDeferredToolSummaries(),
    markDeferredToolDiscovered: (name) => registry.markDeferredToolDiscovered(name),
    isDeferredToolDiscovered: (name) => registry.isDeferredToolDiscovered(name),
    executeDeferredTool: (name, input, ctx) => registry.run(name, input, ctx)
  })) {
    registry.register(tool)
  }
  registry.register({ ...readFileTool, alwaysLoad: true })
  registry.register({ ...listDirTool, alwaysLoad: true })
  registry.register({ ...globTool, alwaysLoad: true })
  registry.register({ ...grepTool, alwaysLoad: true })
  registry.register({ ...codebaseSearchTool, alwaysLoad: true })
  // 知识库搜索工具：仅在向量存储可用时注册（better-sqlite3 原生模块已编译）。
  const kbProbe = probeKnowledgeStore()
  if (kbProbe.ok) {
    registry.register({ ...knowledgeSearchTool, deferred: true })
  }
  registry.register({ ...terminalTool, alwaysLoad: true, permissionGroup: 'terminal' })
  registry.register({ ...powerShellTool, alwaysLoad: true, permissionGroup: 'terminal' })
  registry.register({ ...startTerminalTaskTool, alwaysLoad: true, permissionGroup: 'terminal' })
  registry.register({ ...readTerminalTaskTool, alwaysLoad: true })
  registry.register({ ...stopTerminalTaskTool, alwaysLoad: true })
  registry.register({ ...writeTerminalTaskTool, alwaysLoad: true, permissionGroup: 'terminal' })
  registry.register({ ...sleepTool, alwaysLoad: true })
  registry.register({ ...getDiagnosticsTool, alwaysLoad: true })
  registry.register({ ...searchHistoryTool, alwaysLoad: true })
  registry.register({ ...listConversationsTool, deferred: true })
  registry.register({ ...readConversationTool, deferred: true })
  registry.register({ ...appendNoteTool, alwaysLoad: true })
  registry.register({ ...searchMemoryTool, alwaysLoad: true })
  registry.register({ ...snipHistoryTool, deferred: true })
  registry.register({ ...webFetchTool, deferred: true, supportsBackgroundExecution: true })
  registry.register({ ...webSearchTool, deferred: true, supportsBackgroundExecution: true })
  registry.register(askUserTool)
  registry.register({ ...askUserQuestionTool, deferred: true })
  registry.register({ ...enterWorktreeTool, deferred: true })
  registry.register({ ...exitWorktreeTool, deferred: true })
  registry.register({ ...contextInspectTool, deferred: true })
  registry.register(todoWriteTool)
  registry.register(taskCreateTool)
  registry.register(taskUpdateTool)
  registry.register(taskListTool)
  registry.register(taskGetTool)
  registry.register(skillTool)
  registry.register({ ...installSkillTool, alwaysLoad: true })
  registry.register({ ...installPluginTool, alwaysLoad: true })
  registry.register({ ...reloadMcpServersTool, deferred: true })
  registry.register({ ...modelConfigTool, deferred: true })
  registry.register({ ...mediaConfigTool, deferred: true })
  registry.register(createRunSubagentTool())
  registry.register({ ...notebookReadTool, deferred: true })
  registry.register({ ...notebookEditTool, deferred: true })
  
  
  registry.register({ ...browserOpenTool, deferred: true, permissionGroup: 'browser' })
  registry.register({ ...browserNavigateTool, deferred: true, permissionGroup: 'browser' })
  registry.register({ ...browserClickTool, deferred: true, permissionGroup: 'browser' })
  registry.register({ ...browserTypeTool, deferred: true, permissionGroup: 'browser' })
  registry.register({ ...browserSnapshotTool, deferred: true, supportsBackgroundExecution: true, permissionGroup: 'browser' })
  registry.register({ ...browserGetContentTool, deferred: true, supportsBackgroundExecution: true, permissionGroup: 'browser' })
  registry.register({ ...browserScreenshotTool, deferred: true, supportsBackgroundExecution: true, permissionGroup: 'browser' })
  registry.register({ ...browserWaitForTool, deferred: true, supportsBackgroundExecution: true, permissionGroup: 'browser' })
  registry.register({ ...browserHandoffTool, deferred: true, permissionGroup: 'browser' })
  registry.register({ ...browserTabsTool, deferred: true, permissionGroup: 'browser' })
  registry.register({ ...browserCookiesTool, deferred: true, permissionGroup: 'browser' })
  registry.register({ ...browserCloseTool, deferred: true, permissionGroup: 'browser' })
  registry.register({ ...openInAppBrowserTool, deferred: true })
  registry.register({ ...generateImageTool, deferred: true })
  registry.register({ ...editImageTool, deferred: true })
  registry.register({ ...generateVideoTool, deferred: true })
  registry.register({ ...getVideoTaskTool, deferred: true })
  registry.register({ ...generateAudioTool, deferred: true })
  registry.register({ ...desktopLaunchAppTool, deferred: true, permissionGroup: 'desktop' })
  registry.register({ ...desktopListWindowsTool, deferred: true, permissionGroup: 'desktop' })
  registry.register({ ...desktopGetWindowTool, deferred: true, permissionGroup: 'desktop' })
  registry.register({ ...desktopSnapshotTool, deferred: true, permissionGroup: 'desktop' })
  registry.register({ ...desktopClickTool, deferred: true, permissionGroup: 'desktop' })
  registry.register({ ...desktopTypeTool, deferred: true, permissionGroup: 'desktop' })
  registry.register({ ...desktopMouseTool, deferred: true, permissionGroup: 'desktop' })
  registry.register({ ...desktopMouseMoveTool, deferred: true, permissionGroup: 'desktop' })
  registry.register({ ...desktopDragTool, deferred: true, permissionGroup: 'desktop' })
  registry.register({ ...desktopScrollTool, deferred: true, permissionGroup: 'desktop' })
  registry.register({ ...desktopScreenshotTool, deferred: true, supportsBackgroundExecution: true, permissionGroup: 'desktop' })
  registry.register({ ...desktopWaitForTool, deferred: true, supportsBackgroundExecution: true, permissionGroup: 'desktop' })
  registry.register({ ...desktopHandoffTool, deferred: true, permissionGroup: 'desktop' })
  registry.register({ ...desktopCloseAppTool, deferred: true, destructive: true, permissionGroup: 'desktop' })
  registry.register(writeFileTool)
  registry.register(editFileTool)
  registry.register({ ...multiEditTool, deferred: true })
  registry.register(deleteFileTool)
  return registry
}
