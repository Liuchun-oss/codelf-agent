import { z } from 'zod'
import type { Tool, ToolResult } from './types'
import { SLEEP_DESCRIPTION, SLEEP_NAME } from '../prompts/tools/sleep'

const MAX_SLEEP_MS = 5 * 60 * 1000

const sleepSchema = z.object({
  duration_ms: z.number().int().min(1).max(MAX_SLEEP_MS).describe('How long to wait in milliseconds'),
  reason: z.string().max(300).optional().describe('Why the wait is useful')
})

type SleepInput = z.infer<typeof sleepSchema>

function wait(ms: number, signal?: AbortSignal): Promise<'done' | 'aborted'> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve('aborted')
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve('done')
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve('aborted')
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export const sleepTool: Tool<SleepInput> = {
  name: SLEEP_NAME,
  description: SLEEP_DESCRIPTION,
  schema: sleepSchema,
  readOnly: true,
  concurrencySafe: false,
  deferred: true,
  supportsBackgroundExecution: true,
  async execute(input, ctx): Promise<ToolResult> {
    const started = Date.now()
    const result = await wait(input.duration_ms, ctx.signal)
    const elapsed = Date.now() - started
    if (result === 'aborted') return { content: `Sleep cancelled after ${elapsed}ms`, isError: true }
    return { content: `Slept for ${elapsed}ms${input.reason ? ` (${input.reason})` : ''}` }
  }
}
