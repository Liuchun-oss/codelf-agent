import type { ToolCallRequest, StreamChunk } from '../providers'
import type { ToolContext, ToolResult } from './types'
import type { ToolRegistry } from './registry'



const PARALLEL_LIMIT = 10

interface AccEntry {
  id: string
  name: string
  arguments: string
}

export class ToolCallAccumulator {
  private byIndex = new Map<number, AccEntry>()

  add(chunk: Extract<StreamChunk, { type: 'tool_call_delta' }>): void {
    const entry = this.byIndex.get(chunk.index) ?? { id: '', name: '', arguments: '' }
    if (chunk.id) entry.id = chunk.id
    if (chunk.name) entry.name = chunk.name
    if (chunk.argumentsDelta) entry.arguments += chunk.argumentsDelta
    this.byIndex.set(chunk.index, entry)
  }

  get size(): number {
    return this.byIndex.size
  }

  snapshot(index: number): ToolCallRequest | null {
    const entry = this.byIndex.get(index)
    if (!entry) return null
    return {
      id: entry.id || `call_${index}`,
      name: entry.name,
      arguments: entry.arguments
    }
  }

  
  finalize(): ToolCallRequest[] {
    return [...this.byIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, e]) => ({
        id: e.id || `call_${index}`,
        name: e.name,
        arguments: e.arguments
      }))
      .filter((c) => c.name.length > 0)
  }
}


export function parseToolArguments(raw: string): unknown {
  const trimmed = raw.trim()
  if (!trimmed) return {}
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

async function runOne(
  call: ToolCallRequest,
  registry: ToolRegistry,
  ctx: ToolContext
): Promise<ToolResult> {
  const args = parseToolArguments(call.arguments)
  if (args === undefined) {
    return { content: `工具参数 JSON 解析失败：${call.arguments}`, isError: true }
  }
  return registry.run(call.name, args, { ...ctx, toolCallId: call.id })
}


export async function executeToolBatch(
  calls: ToolCallRequest[],
  registry: ToolRegistry,
  ctx: ToolContext
): Promise<Map<string, ToolResult>> {
  const results = new Map<string, ToolResult>()

  const canParallel = (c: ToolCallRequest): boolean => {
    const t = registry.get(c.name)
    return !!t && t.readOnly && t.concurrencySafe
  }
  const parallel = calls.filter(canParallel)
  const serial = calls.filter((c) => !canParallel(c))

  for (let i = 0; i < parallel.length; i += PARALLEL_LIMIT) {
    const chunk = parallel.slice(i, i + PARALLEL_LIMIT)
    const settled = await Promise.all(chunk.map((c) => runOne(c, registry, ctx)))
    chunk.forEach((c, idx) => results.set(c.id, settled[idx]))
  }

  for (const c of serial) {
    results.set(c.id, await runOne(c, registry, ctx))
  }

  return results
}
