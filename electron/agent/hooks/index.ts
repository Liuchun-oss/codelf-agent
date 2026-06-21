import { loadMergedHooks, getMatchingHooks } from './config'
import { runHooks } from './runner'
import type { HookEvent, HookInput, HookRunResult, HooksSettings } from './types'

export * from './types'
export { loadMergedHooks, getMatchingHooks } from './config'
export { runHooks } from './runner'

const EMPTY_RESULT: HookRunResult = {
  additionalContext: [],
  systemMessages: [],
  blocked: false,
  stopProcessing: false
}

export class HookRunner {
  private hooks: HooksSettings = {}
  private workspaceRoot: string | null = null

  load(workspaceRoot?: string | null): void {
    this.workspaceRoot = workspaceRoot ?? null
    this.hooks = loadMergedHooks(workspaceRoot)
  }

  hasAny(event: HookEvent, matchQuery?: string): boolean {
    return getMatchingHooks(this.hooks, event, matchQuery).length > 0
  }

  async dispatch(event: HookEvent, input: HookInput, matchQuery: string | undefined, signal?: AbortSignal): Promise<HookRunResult> {
    const commands = getMatchingHooks(this.hooks, event, matchQuery)
    if (commands.length === 0) return { ...EMPTY_RESULT, additionalContext: [], systemMessages: [] }
    const cwd = this.workspaceRoot || input.cwd
    return runHooks(commands, input, cwd, signal)
  }
}
