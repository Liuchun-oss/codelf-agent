import { randomUUID } from 'crypto'
import type { AgentEvent } from '@shared/agentTypes'
import type { ToolCallRequest } from '../providers'
import type { ToolContext, ToolResult } from '../tools/types'

type BackgroundStatus = 'queued' | 'executing' | 'completed' | 'yielded' | 'error' | 'cancelled'
type BackgroundToolEventSink = (event: AgentEvent) => void

interface BackgroundToolRecord {
  id: string
  sessionId: string
  turnId: string
  callId: string
  toolName: string
  status: BackgroundStatus
  createdAt: number
  startedAt?: number
  completedAt?: number
  controller: AbortController
  promise: Promise<ToolResult>
  result?: ToolResult
}

export interface StartBackgroundToolParams {
  sessionId: string
  turnId: string
  call: ToolCallRequest
  ctx: ToolContext
  run: (ctx: ToolContext) => Promise<ToolResult>
}

const records = new Map<string, BackgroundToolRecord>()
const eventSinks = new Map<string, BackgroundToolEventSink>()

function emit(sessionId: string, event: AgentEvent): void {
  eventSinks.get(sessionId)?.(event)
}

function mergeAbortSignals(parent: AbortSignal | undefined, child: AbortController): AbortSignal {
  if (!parent) return child.signal
  if (parent.aborted) child.abort()
  else parent.addEventListener('abort', () => child.abort(), { once: true })
  return child.signal
}

export function setBackgroundToolEventSink(sessionId: string, sink: BackgroundToolEventSink | null): void {
  if (!sessionId) return
  if (sink) eventSinks.set(sessionId, sink)
  else eventSinks.delete(sessionId)
}

export function clearAllBackgroundToolEventSinks(): void {
  eventSinks.clear()
}

export function startBackgroundTool(params: StartBackgroundToolParams): BackgroundToolRecord {
  const id = `background-${randomUUID()}`
  const controller = new AbortController()
  const signal = mergeAbortSignals(params.ctx.signal, controller)
  const emitProgress = (event: AgentEvent): void => {
    if (params.ctx.emitEvent) params.ctx.emitEvent(event)
    else emit(params.sessionId, event)
  }
  const baseCtx: ToolContext = {
    ...params.ctx,
    signal,
    toolCallId: params.call.id,
    emitEvent: emitProgress
  }

  const record: BackgroundToolRecord = {
    id,
    sessionId: params.sessionId,
    turnId: params.turnId,
    callId: params.call.id,
    toolName: params.call.name,
    status: 'queued',
    createdAt: Date.now(),
    controller,
    promise: Promise.resolve({ content: '' })
  }
  records.set(id, record)

  emitProgress({
    type: 'tool_call_progress',
    turnId: params.turnId,
    callId: params.call.id,
    backgroundId: id,
    deferredId: id,
    status: 'queued',
    message: `Background tool queued: ${params.call.name}`
  })

  record.promise = (async () => {
    record.status = 'executing'
    record.startedAt = Date.now()
    emitProgress({
      type: 'tool_call_progress',
      turnId: params.turnId,
      callId: params.call.id,
      backgroundId: id,
      deferredId: id,
      status: 'running',
      message: `Background tool started: ${params.call.name}`
    })
    try {
      const result = await params.run(baseCtx)
      record.result = result
      record.status = result.isError ? 'error' : 'completed'
      record.completedAt = Date.now()
      emitProgress({
        type: 'tool_call_progress',
        turnId: params.turnId,
        callId: params.call.id,
        backgroundId: id,
        deferredId: id,
        status: result.isError ? 'error' : 'completed',
        message: result.isError ? `Background tool failed: ${params.call.name}` : `Background tool completed: ${params.call.name}`
      })
      return result
    } catch (e) {
      const result: ToolResult = {
        content: e instanceof Error ? e.message : 'Background tool execution failed',
        isError: true
      }
      record.result = result
      record.status = controller.signal.aborted ? 'cancelled' : 'error'
      record.completedAt = Date.now()
      emitProgress({
        type: 'tool_call_progress',
        turnId: params.turnId,
        callId: params.call.id,
        backgroundId: id,
        deferredId: id,
        status: 'error',
        message: record.status === 'cancelled' ? `Background tool cancelled: ${params.call.name}` : `Background tool failed: ${params.call.name}`
      })
      return result
    }
  })()

  return record
}

export async function awaitBackgroundTool(backgroundId: string): Promise<ToolResult> {
  const record = records.get(backgroundId)
  if (!record) return { content: `Background tool not found: ${backgroundId}`, isError: true }
  const result = await record.promise
  record.status = record.status === 'error' || record.status === 'cancelled' ? record.status : 'yielded'
  return result
}

export function cancelSessionBackgroundTools(sessionId: string): void {
  for (const record of records.values()) {
    if (record.sessionId !== sessionId) continue
    if (record.status === 'completed' || record.status === 'yielded' || record.status === 'error' || record.status === 'cancelled') continue
    record.controller.abort()
    record.status = 'cancelled'
  }
}

export function clearSessionBackgroundTools(sessionId: string): void {
  cancelSessionBackgroundTools(sessionId)
  for (const [id, record] of records) {
    if (record.sessionId === sessionId) records.delete(id)
  }
  eventSinks.delete(sessionId)
}

export const setDeferredToolEventSink = setBackgroundToolEventSink
export const startDeferredTool = startBackgroundTool
export const awaitDeferredTool = awaitBackgroundTool
export const cancelSessionDeferredTools = cancelSessionBackgroundTools
export const clearSessionDeferredTools = clearSessionBackgroundTools
export type StartDeferredToolParams = StartBackgroundToolParams
