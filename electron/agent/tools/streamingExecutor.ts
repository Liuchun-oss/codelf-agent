import type { ToolCallRequest, StreamChunk } from '../providers'
import type { ToolContext, ToolResult } from './types'
import type { ToolRegistry } from './registry'
import { getAgentBehaviorSettings } from '../settings/agentSettingsStore'



const DEFAULT_PARALLEL_LIMIT = 10

function resolveParallelLimit(): number {
  try {
    return getAgentBehaviorSettings().parallelToolLimit || DEFAULT_PARALLEL_LIMIT
  } catch {
    return DEFAULT_PARALLEL_LIMIT
  }
}

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
    const ordered = [...this.byIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, e]) => ({
        id: e.id || `call_${index}`,
        name: e.name,
        arguments: e.arguments
      }))
      .filter((c) => c.name.length > 0)
    return dedupeToolCallsById(ordered)
  }
}

// 防御性去重：部分中转站（openai-compatible）在流式返回工具调用时不守协议——
// 把「同一个」tool_call 拆到不同的 index，或在推理/正式两阶段各完整下发一遍，
// 导致累积器按 index 得到多个条目，最终同一条命令被执行两次。
// 合法的并行调用其 id 必定互不相同，故按「非空 id」合并可安全消除这类重复：
// 同一非空 id 只保留首个条目，并把后续分片里更完整的 name/arguments 补齐。
// id 为空的条目（罕见异常）不参与合并，原样保留，避免误伤。
function dedupeToolCallsById(calls: ToolCallRequest[]): ToolCallRequest[] {
  const byId = new Map<string, ToolCallRequest>()
  const out: ToolCallRequest[] = []
  for (const call of calls) {
    const existing = byId.get(call.id)
    if (!existing) {
      byId.set(call.id, call)
      out.push(call)
      continue
    }
    if (!existing.name && call.name) existing.name = call.name
    if (call.arguments.length > existing.arguments.length) existing.arguments = call.arguments
  }
  return out
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

  const parallelLimit = resolveParallelLimit()
  for (let i = 0; i < parallel.length; i += parallelLimit) {
    const chunk = parallel.slice(i, i + parallelLimit)
    const settled = await Promise.all(chunk.map((c) => runOne(c, registry, ctx)))
    chunk.forEach((c, idx) => results.set(c.id, settled[idx]))
  }

  for (const c of serial) {
    results.set(c.id, await runOne(c, registry, ctx))
  }

  return results
}
