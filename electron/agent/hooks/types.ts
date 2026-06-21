export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse'] as const

export type HookEvent = (typeof HOOK_EVENTS)[number]

export type HookShell = 'bash' | 'powershell'

export interface HookCommand {
  type: 'command'
  command: string
  shell?: HookShell
  timeout?: number
  statusMessage?: string
}

export interface HookMatcher {
  matcher?: string
  hooks: HookCommand[]
}

export type HooksSettings = Partial<Record<HookEvent, HookMatcher[]>>

export interface BaseHookInput {
  session_id: string
  cwd: string
  permission_mode?: string
  hook_event_name: HookEvent
}

export interface SessionStartHookInput extends BaseHookInput {
  hook_event_name: 'SessionStart'
  source: string
}

export interface UserPromptSubmitHookInput extends BaseHookInput {
  hook_event_name: 'UserPromptSubmit'
  prompt: string
}

export interface PreToolUseHookInput extends BaseHookInput {
  hook_event_name: 'PreToolUse'
  tool_name: string
  tool_input: unknown
}

export interface PostToolUseHookInput extends BaseHookInput {
  hook_event_name: 'PostToolUse'
  tool_name: string
  tool_input: unknown
  tool_response: unknown
  tool_use_id?: string
}

export type HookInput =
  | SessionStartHookInput
  | UserPromptSubmitHookInput
  | PreToolUseHookInput
  | PostToolUseHookInput

export type HookPermissionDecision = 'allow' | 'deny' | 'ask'

export interface HookSpecificOutput {
  hookEventName?: string
  permissionDecision?: HookPermissionDecision
  permissionDecisionReason?: string
  updatedInput?: Record<string, unknown>
  additionalContext?: string
}

export interface HookJsonOutput {
  continue?: boolean
  stopReason?: string
  suppressOutput?: boolean
  decision?: 'approve' | 'block'
  reason?: string
  systemMessage?: string
  hookSpecificOutput?: HookSpecificOutput
}

export interface HookRunResult {
  permissionDecision?: HookPermissionDecision
  permissionDecisionReason?: string
  updatedInput?: Record<string, unknown>
  additionalContext: string[]
  systemMessages: string[]
  blocked: boolean
  blockReason?: string
  stopProcessing: boolean
}
