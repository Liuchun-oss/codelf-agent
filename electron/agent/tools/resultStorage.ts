import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import type { ContentReplacementRecord } from '@shared/agentTypes'
import type { ToolCallRequest } from '../providers'
import type { ToolResult } from './types'
import { tmpName } from '@shared/appConfig'


export const TOOL_RESULT_INLINE_MAX_BYTES = 50 * 1024
export const TOOL_RESULT_BATCH_INLINE_MAX_BYTES = 100 * 1024

const PREVIEW_CHARS = 2000

export interface ContentReplacementState {
  seenIds: Set<string>
  replacements: Map<string, string>
}

export function createContentReplacementState(): ContentReplacementState {
  return { seenIds: new Set(), replacements: new Map() }
}

export function cloneContentReplacementState(source: ContentReplacementState): ContentReplacementState {
  return {
    seenIds: new Set(source.seenIds),
    replacements: new Map(source.replacements)
  }
}

export function exportContentReplacementRecords(state: ContentReplacementState): ContentReplacementRecord[] {
  const ids = new Set([...state.seenIds, ...state.replacements.keys()])
  return [...ids].map((toolUseId) => ({
    kind: 'tool-result' as const,
    toolUseId,
    ...(state.replacements.has(toolUseId) ? { replacement: state.replacements.get(toolUseId) } : {})
  }))
}

export function createContentReplacementStateFromRecords(
  records?: readonly ContentReplacementRecord[]
): ContentReplacementState {
  const state = createContentReplacementState()
  for (const record of records ?? []) {
    if (record.kind !== 'tool-result' || !record.toolUseId) continue
    state.seenIds.add(record.toolUseId)
    if (typeof record.replacement === 'string') state.replacements.set(record.toolUseId, record.replacement)
  }
  return state
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}


export function externalizeLargeToolResult(result: ToolResult, id?: string): ToolResult {
  if (result.fileChange) return result
  const bytes = Buffer.byteLength(result.content, 'utf8')
  if (bytes <= TOOL_RESULT_INLINE_MAX_BYTES) return result
  return externalizeToolResult(result, bytes, id)
}

function applyCachedReplacement(result: ToolResult, replacement: string): ToolResult {
  return {
    ...result,
    truncated: true,
    content: replacement
  }
}

function externalizeToolResult(result: ToolResult, bytes: number, id?: string): ToolResult {
  const dir = join(tmpdir(), tmpName('tool-results'))
  mkdirSync(dir, { recursive: true })
  const safeId = id?.replace(/[^a-zA-Z0-9_.-]/g, '_') || randomUUID()
  const filePath = join(dir, `${safeId}.txt`)
  writeFileSync(filePath, result.content, 'utf8')

  const preview =
    result.content.length > PREVIEW_CHARS
      ? result.content.slice(0, PREVIEW_CHARS) + '\n…'
      : result.content

  return {
    ...result,
    truncated: true,
    content: [
      `Tool output was large (${formatBytes(bytes)}). Full output saved to:`,
      filePath,
      '',
      'Preview:',
      preview
    ].join('\n')
  }
}


export function externalizeToolResultsWithState(
  calls: ToolCallRequest[],
  results: Map<string, ToolResult>,
  state: ContentReplacementState,
  batchLimitBytes = TOOL_RESULT_BATCH_INLINE_MAX_BYTES
): Map<string, ToolResult> {
  const out = new Map(results)
  let visibleBytes = 0
  const fresh: Array<{ id: string; result: ToolResult; bytes: number }> = []

  for (const call of calls) {
    const result = results.get(call.id)
    if (!result) continue
    const cachedReplacement = state.replacements.get(call.id)
    if (cachedReplacement !== undefined) {
      out.set(call.id, applyCachedReplacement(result, cachedReplacement))
      visibleBytes += Buffer.byteLength(cachedReplacement, 'utf8')
      continue
    }
    if (result.fileChange || result.truncated || state.seenIds.has(call.id)) {
      state.seenIds.add(call.id)
      visibleBytes += Buffer.byteLength(result.content, 'utf8')
      continue
    }
    const bytes = Buffer.byteLength(result.content, 'utf8')
    visibleBytes += bytes
    fresh.push({ id: call.id, result, bytes })
  }

  const toReplace = new Set<string>()
  for (const candidate of fresh) {
    if (candidate.bytes > TOOL_RESULT_INLINE_MAX_BYTES) toReplace.add(candidate.id)
  }

  let projectedBytes = visibleBytes
  for (const candidate of fresh) {
    if (toReplace.has(candidate.id)) projectedBytes -= candidate.bytes
  }
  for (const candidate of [...fresh].sort((a, b) => b.bytes - a.bytes)) {
    if (projectedBytes <= batchLimitBytes) break
    if (toReplace.has(candidate.id)) continue
    toReplace.add(candidate.id)
    projectedBytes -= candidate.bytes
  }

  for (const candidate of fresh) {
    state.seenIds.add(candidate.id)
    if (toReplace.has(candidate.id)) {
      const externalized = externalizeToolResult(candidate.result, candidate.bytes, candidate.id)
      out.set(candidate.id, externalized)
      state.replacements.set(candidate.id, externalized.content)
    }
  }

  return out
}

export function externalizeToolResultsWithBudget(
  calls: ToolCallRequest[],
  results: Map<string, ToolResult>,
  batchLimitBytes = TOOL_RESULT_BATCH_INLINE_MAX_BYTES
): Map<string, ToolResult> {
  return externalizeToolResultsWithState(calls, results, createContentReplacementState(), batchLimitBytes)
}
