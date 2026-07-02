import type { PromptContext, SystemPromptParts } from './types'
import { PROMPT_DYNAMIC_BOUNDARY } from './boundary'
import { getIntroSection } from './sections/intro'
import { getSystemSection } from './sections/system'
import { getDoingTasksSection } from './sections/doingTasks'
import { getActionsSection } from './sections/actions'
import { getUsingToolsSection } from './sections/usingTools'
import { getToneAndStyleSection } from './sections/toneAndStyle'
import { getBehavioralGuidelinesSection } from './sections/behavioralGuidelines'
import { getMemorySection } from './sections/memory'
import { getMirrorsSection } from './sections/mirrors'
import { getLanguageSection, getEnvSection } from './sections/language'
import { getWorkingApproachSection } from './sections/workingApproach'
import { getProjectLayoutSection } from './sections/projectLayout'
import { getPersonaSection } from './sections/persona'
import { getRoomSeatSection, getRoomCollabSection } from './sections/roomSeat'
import { getChannelSection } from './sections/channel'
import { collectUserContext, renderUserContext } from './context/userContext'
import { collectSystemContext, renderSystemContext } from './context/systemContext'
import { collectMemoryContext, renderMemoryContext } from './context/memoryContext'
import { collectSubagentContext, renderSubagentContext } from './context/subagentContext'
import { loadApplicableSkills, renderAvailableSkillsSection, summarizeSkill } from '../skills/loadSkills'


function permissionModeMarker(mode: PromptContext['permissionMode']): string {
  const label = mode === 'acceptEdits' ? '**Accept Edits**' : '**Default**'
  return `# Runtime context\nActive permission mode: ${label}.`
}

// 该岗位是否绕过内置系统提示词：仅群聊岗位且显式开启 rawSystemPrompt 时为真。
// 开启后 system prompt 只用岗位人设（personaPrompt），不注入任何 Codelf 内置段落。
function usesRawSystemPrompt(ctx: PromptContext): boolean {
  return !!ctx.roomContext?.seat.rawSystemPrompt
}

// 绕过模式下的裸 system prompt：岗位人设正文 + 群协作说明段（保留成员名单/协作协议/发言纪律），
// 不注入其它 Codelf 内置段。人设为空则仅保留群协作说明。
function rawSystemPromptText(ctx: PromptContext): string {
  return filterEmpty([
    (ctx.roomContext?.seat.personaPrompt ?? '').trim(),
    getRoomCollabSection(ctx)
  ]).join('\n\n')
}

/**
 * 会话内易变、但不进 system 的运行时上下文，由调用方注入到消息数组尾部
 * （历史之后、当前轮之前）。该块不写入历史。当前仅包含权限模式标注。
 */
export function fetchDynamicContextBlock(ctx: PromptContext): string | null {
  const parts = filterEmpty([permissionModeMarker(ctx.permissionMode)])
  return parts.length > 0 ? parts.join('\n\n') : null
}

/**
 * 构建系统提示的「静态核心」——仅包含在单个会话内绝对不会变化的段。
 * 用于 promptCacheKey 的 hash 源，确保 git 提交、append_note 等操作不会导致缓存全量失效。
 * 同时也是 messages 数组的第一条独立 system 消息，内容不变 → 缓存前缀恒命中。
 */
export function getStaticSystemCore(ctx: PromptContext): string {
  // 绕过内置提示词：静态核心即裸人设，保证 promptCacheKey 与实际 system 前缀一致。
  if (usesRawSystemPrompt(ctx)) return rawSystemPromptText(ctx)
  return filterEmpty([
    getIntroSection(ctx),
    getSystemSection(ctx),
    getWorkingApproachSection(ctx),
    getProjectLayoutSection(ctx),
    getDoingTasksSection(),
    getActionsSection(),
    getUsingToolsSection(ctx),
    getMemorySection(ctx),
    getToneAndStyleSection(),
    getBehavioralGuidelinesSection(),
    getLanguageSection(ctx),
    getMirrorsSection(ctx),
    getEnvSection(ctx),
  ]).join('\n\n')
}


export async function fetchSystemPromptPartsAsync(
  ctx: PromptContext,
  signal?: AbortSignal
): Promise<SystemPromptParts> {
  // 绕过内置提示词：只用岗位人设作为唯一 system 内容，不加载技能/记忆/上下文等任何内置段。
  if (usesRawSystemPrompt(ctx)) {
    return { systemPrompt: filterEmpty([rawSystemPromptText(ctx)]) }
  }
  const [userCtxSnap, sysCtxSnap, memCtxSnap, skills] = await Promise.all([
    collectUserContext(ctx),
    collectSystemContext(ctx, signal),
    collectMemoryContext(ctx),
    loadApplicableSkills({ workspaceRoot: ctx.workspacePath, activeFilePath: ctx.activeFilePath })
  ])
  const userCtx = renderUserContext(userCtxSnap)
  const sysCtx = renderSystemContext(sysCtxSnap)
  const memCtx = renderMemoryContext(memCtxSnap)
  const subagentCtx = renderSubagentContext(collectSubagentContext(ctx))
  const skillsCtx = renderAvailableSkillsSection(skills.map(summarizeSkill))

  const staticSections: string[] = filterEmpty([
    getIntroSection(ctx),
    getSystemSection(ctx),
    getWorkingApproachSection(ctx),
    getProjectLayoutSection(ctx),
    getDoingTasksSection(),
    getActionsSection(),
    getUsingToolsSection(ctx),
    getMemorySection(ctx),
    getToneAndStyleSection(),
    getBehavioralGuidelinesSection()
  ])

  const dynamicSections: string[] = filterEmpty([
    getPersonaSection(ctx),
    getRoomSeatSection(ctx),
    getChannelSection(ctx),
    getLanguageSection(ctx),
    getMirrorsSection(ctx),
    getEnvSection(ctx),
    userCtx,
    subagentCtx,
    skillsCtx,
    sysCtx,
    memCtx
  ])

  return {
    systemPrompt: [...staticSections, PROMPT_DYNAMIC_BOUNDARY, ...dynamicSections]
  }
}


export function fetchSystemPromptParts(ctx: PromptContext): SystemPromptParts {
  if (usesRawSystemPrompt(ctx)) {
    return { systemPrompt: filterEmpty([rawSystemPromptText(ctx)]) }
  }
  const staticSections: string[] = filterEmpty([
    getIntroSection(ctx),
    getSystemSection(ctx),
    getWorkingApproachSection(ctx),
    getProjectLayoutSection(ctx),
    getDoingTasksSection(),
    getActionsSection(),
    getUsingToolsSection(ctx),
    getMemorySection(ctx),
    getToneAndStyleSection(),
    getBehavioralGuidelinesSection()
  ])
  const dynamicSections: string[] = filterEmpty([getPersonaSection(ctx), getRoomSeatSection(ctx), getChannelSection(ctx), getLanguageSection(ctx), getMirrorsSection(ctx), getEnvSection(ctx)])
  return {
    systemPrompt: [...staticSections, PROMPT_DYNAMIC_BOUNDARY, ...dynamicSections]
  }
}

function filterEmpty(arr: Array<string | null | undefined>): string[] {
  return arr.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
}


export function assembleSystemMessage(parts: SystemPromptParts): string {
  return parts.systemPrompt
    .filter((s) => s && s !== PROMPT_DYNAMIC_BOUNDARY)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join('\n\n')
}
