import { spawn } from 'child_process'
import { shellInvocation } from '../../services/headlessTerminal'
import { ENV_PROJECT_DIR } from '@shared/appConfig'
import type {
  HookCommand,
  HookEvent,
  HookInput,
  HookJsonOutput,
  HookRunResult
} from './types'

const DEFAULT_HOOK_TIMEOUT_MS = 30_000
const MAX_HOOK_OUTPUT = 256 * 1024

interface SingleHookOutcome {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

function runOneHook(cmd: HookCommand, input: HookInput, cwd: string, signal?: AbortSignal): Promise<SingleHookOutcome> {
  const { file, args } = shellInvocation(cmd.command)
  const timeoutMs = cmd.timeout && cmd.timeout > 0 ? cmd.timeout * 1000 : DEFAULT_HOOK_TIMEOUT_MS

  return new Promise<SingleHookOutcome>((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const child = spawn(file, args, {
      cwd,
      env: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...process.env, CLAUDE_PROJECT_DIR: cwd, [ENV_PROJECT_DIR]: cwd },
      windowsHide: true
    })
    const finish = (exitCode: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ exitCode, stdout, stderr, timedOut })
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    const onAbort = () => {
      timedOut = true
      child.kill('SIGKILL')
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_HOOK_OUTPUT) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_HOOK_OUTPUT) stderr += chunk.toString('utf8')
    })
    child.on('error', () => finish(null))
    child.on('close', (code) => finish(code))

    try {
      child.stdin?.write(`${JSON.stringify(input)}\n`, 'utf8')
      child.stdin?.end()
    } catch {
      // ignore stdin write failures; hook may not read stdin
    }
  })
}

function parseHookJson(stdout: string): HookJsonOutput | null {
  const trimmed = stdout.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    return JSON.parse(trimmed) as HookJsonOutput
  } catch {
    return null
  }
}

function applyOutcome(result: HookRunResult, event: HookEvent, outcome: SingleHookOutcome): void {
  // Exit code 2 = blocking feedback (stderr fed back to model).
  if (outcome.exitCode === 2) {
    result.blocked = true
    result.blockReason = outcome.stderr.trim() || 'Blocked by hook (exit code 2)'
    if (event === 'PreToolUse') result.permissionDecision = 'deny'
    return
  }

  const json = parseHookJson(outcome.stdout)
  if (!json) return

  if (json.continue === false) {
    result.stopProcessing = true
    if (json.stopReason) result.systemMessages.push(json.stopReason)
  }
  if (json.systemMessage) result.systemMessages.push(json.systemMessage)

  // Legacy top-level decision
  if (json.decision === 'block') {
    result.blocked = true
    result.blockReason = json.reason || 'Blocked by hook'
    if (event === 'PreToolUse') result.permissionDecision = 'deny'
  }

  const hso = json.hookSpecificOutput
  if (hso) {
    if (typeof hso.additionalContext === 'string' && hso.additionalContext.trim()) {
      result.additionalContext.push(hso.additionalContext.trim())
    }
    if (event === 'PreToolUse') {
      if (hso.permissionDecision) {
        result.permissionDecision = hso.permissionDecision
        if (hso.permissionDecision === 'deny') {
          result.blocked = true
          result.blockReason = hso.permissionDecisionReason || json.reason || 'Blocked by hook'
        }
      }
      if (hso.permissionDecisionReason) result.permissionDecisionReason = hso.permissionDecisionReason
      if (hso.updatedInput && typeof hso.updatedInput === 'object') result.updatedInput = hso.updatedInput
    }
  }
}

export async function runHooks(
  commands: HookCommand[],
  input: HookInput,
  cwd: string,
  signal?: AbortSignal
): Promise<HookRunResult> {
  const result: HookRunResult = {
    additionalContext: [],
    systemMessages: [],
    blocked: false,
    stopProcessing: false
  }
  for (const cmd of commands) {
    if (signal?.aborted) break
    const outcome = await runOneHook(cmd, input, cwd, signal)
    applyOutcome(result, input.hook_event_name, outcome)
    if (result.blocked || result.stopProcessing) break
  }
  return result
}
