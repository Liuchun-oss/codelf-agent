import { z } from 'zod'
import type { Tool, ToolContext, ToolResult } from './types'

export const SEARCH_EXTRA_TOOLS_NAME = 'SearchExtraTools'
export const EXECUTE_EXTRA_TOOL_NAME = 'ExecuteExtraTool'

export interface DeferredToolSummary {
  name: string
  description: string
  readOnly: boolean
  concurrencySafe: boolean
  destructive?: boolean
  supportsBackgroundExecution?: boolean
  schema?: Record<string, unknown>
}

export interface DeferredToolHost {
  listDeferredTools: () => DeferredToolSummary[]
  markDeferredToolDiscovered: (name: string) => boolean
  isDeferredToolDiscovered: (name: string) => boolean
  executeDeferredTool: (name: string, input: unknown, ctx: ToolContext) => Promise<ToolResult>
}

const searchExtraToolsSchema = z.object({
  query: z.string().min(1).max(300).describe('Query to find deferred tools. Use select:ToolName for exact selection, select:A,B for multi-select, discover:keywords to inspect matches without loading, +term to require a keyword.'),
  limit: z.number().int().min(1).max(20).optional().describe('Maximum number of matching deferred tools to return')
})

type SearchExtraToolsInput = z.infer<typeof searchExtraToolsSchema>

const executeExtraToolSchema = z.object({
  name: z.string().min(1).describe('Deferred tool name returned by SearchExtraTools'),
  arguments: z.record(z.string(), z.unknown()).default({}).describe('JSON object arguments for the deferred tool')
})

type ExecuteExtraToolInput = z.infer<typeof executeExtraToolSchema>

function normalize(s: string): string {
  return s.toLowerCase().trim()
}

function splitQueryTerms(query: string): { required: string[]; optional: string[] } {
  const required: string[] = []
  const optional: string[] = []
  for (const raw of query.toLowerCase().split(/\s+/).map((s) => s.trim()).filter(Boolean)) {
    if (raw.startsWith('+') && raw.length > 1) required.push(raw.slice(1))
    else optional.push(raw)
  }
  return { required, optional }
}

function tokenizeName(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
}

function searchableText(tool: DeferredToolSummary): string {
  return `${tool.name} ${tokenizeName(tool.name).join(' ')} ${tool.description}`.toLowerCase()
}

function scoreTool(tool: DeferredToolSummary, query: string): number {
  const normalized = normalize(query)
  if (!normalized) return 1
  const name = tool.name.toLowerCase()
  const nameParts = tokenizeName(tool.name)
  const description = tool.description.toLowerCase()
  const text = searchableText(tool)
  if (name === normalized) return 100
  if (name.includes(normalized)) return 80

  const { required, optional } = splitQueryTerms(normalized)
  if (required.some((term) => !text.includes(term))) return 0

  const terms = required.length > 0 ? [...required, ...optional] : optional
  if (terms.length === 0) return 0

  let score = 0
  for (const term of terms) {
    if (name === term) score += 30
    else if (nameParts.includes(term)) score += 18
    else if (nameParts.some((part) => part.includes(term))) score += 12
    else if (name.includes(term)) score += 8
    if (description.includes(term)) score += 4
  }
  return score
}

function findByName(tools: DeferredToolSummary[], requestedName: string): DeferredToolSummary | undefined {
  const wanted = normalize(requestedName)
  return tools.find((tool) => normalize(tool.name) === wanted)
}

function selectTools(tools: DeferredToolSummary[], query: string): { matches: DeferredToolSummary[]; missing: string[] } {
  const requested = query.slice('select:'.length).split(',').map((name) => name.trim()).filter(Boolean)
  const matches: DeferredToolSummary[] = []
  const missing: string[] = []
  for (const name of requested) {
    const match = findByName(tools, name)
    if (match) matches.push(match)
    else missing.push(name)
  }
  return { matches, missing }
}

function searchTools(tools: DeferredToolSummary[], query: string, limit: number): DeferredToolSummary[] {
  return tools
    .map((tool) => ({ tool, score: scoreTool(tool, query) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, limit)
    .map((item) => item.tool)
}

function formatToolSummary(tool: DeferredToolSummary): string {
  const flags = [
    tool.readOnly ? 'readOnly' : 'writeCapable',
    tool.concurrencySafe ? 'concurrencySafe' : 'serial',
    tool.destructive ? 'destructive' : null,
    tool.supportsBackgroundExecution ? 'backgroundExecution' : null
  ].filter(Boolean).join(', ')
  return `- ${tool.name} (${flags}): ${tool.description}`
}

function formatDiscoverSummary(tool: DeferredToolSummary): string {
  const schema = tool.schema ? JSON.stringify(tool.schema) : '{...}'
  return `${formatToolSummary(tool)}\n  schema: ${schema}\n  execute: use ExecuteExtraTool with {"name":"${tool.name}","arguments":{...}} after selecting the tool.`
}

export function createDeferredDiscoveryTools(host: DeferredToolHost): Tool<unknown>[] {
  const searchTool: Tool<SearchExtraToolsInput> = {
    name: SEARCH_EXTRA_TOOLS_NAME,
    description: 'Search for deferred tools by name or keyword. LOW PRIORITY — only use this tool when no core tool can accomplish the task. Core tools are always available and should be used directly. Deferred tools CANNOT be called directly: first use SearchExtraTools with select:ToolName or discover:keywords, then use ExecuteExtraTool with the exact name and arguments. Supports select:ToolName, select:A,B, discover:keywords, keyword search, and +required terms. If ExecuteExtraTool fails, do NOT re-search for the same tool — stop and tell the user what failed.',
    schema: searchExtraToolsSchema,
    readOnly: true,
    concurrencySafe: true,
    async execute(input): Promise<ToolResult> {
      const limit = input.limit ?? 10
      const query = input.query.trim()
      const tools = host.listDeferredTools()

      if (/^select:/i.test(query)) {
        const { matches, missing } = selectTools(tools, query)
        for (const tool of matches) host.markDeferredToolDiscovered(tool.name)
        if (matches.length === 0) {
          return { content: `No deferred tools found for query: ${input.query}${missing.length ? `\nMissing: ${missing.join(', ')}` : ''}` }
        }
        return {
          content: [
            `Found ${matches.length} deferred tool(s). Run them now with ExecuteExtraTool ({"name":"<tool>","arguments":{...}}); they are not added to the tools schema.`,
            missing.length ? `Missing: ${missing.join(', ')}` : null,
            ...matches.map(formatDiscoverSummary)
          ].filter(Boolean).join('\n')
        }
      }

      if (/^discover:/i.test(query)) {
        const discoverQuery = query.slice('discover:'.length).trim()
        const matches = searchTools(tools, discoverQuery, limit)
        if (matches.length === 0) return { content: `No matching deferred tools found for query: ${discoverQuery}` }
        return {
          content: [
            `Found ${matches.length} deferred tool(s) for discovery only. These tools were not enabled; call SearchExtraTools with query="select:ToolName" before ExecuteExtraTool.`,
            ...matches.map(formatDiscoverSummary)
          ].join('\n')
        }
      }

      const matches = searchTools(tools, query, limit)
      for (const tool of matches) host.markDeferredToolDiscovered(tool.name)
      if (matches.length === 0) {
        return { content: `No deferred tools found for query: ${input.query}` }
      }
      return {
        content: [
          `Found ${matches.length} deferred tool(s). Run them now with ExecuteExtraTool ({"name":"<tool>","arguments":{...}}); they are not added to the tools schema.`,
          ...matches.map(formatDiscoverSummary)
        ].join('\n')
      }
    }
  }

  const executeTool: Tool<ExecuteExtraToolInput> = {
    name: EXECUTE_EXTRA_TOOL_NAME,
    description: 'ExecuteExtraTool — always loaded, always available. Runs a deferred tool locally after it has been found with SearchExtraTools. ONLY use this for deferred tools discovered via SearchExtraTools; core tools should be called directly. Pass the exact tool name in name and a JSON arguments object in arguments. If this tool returns an error, do NOT retry or re-search; tell the user what failed and suggest alternatives.',
    schema: executeExtraToolSchema,
    readOnly: false,
    concurrencySafe: false,
    async execute(input, ctx): Promise<ToolResult> {
      if (!host.isDeferredToolDiscovered(input.name)) {
        return { content: `Deferred tool is not discovered yet: ${input.name}. Call SearchExtraTools with query="select:${input.name}" first.`, isError: true }
      }
      return host.executeDeferredTool(input.name, input.arguments, ctx)
    }
  }

  return [searchTool, executeTool]
}
