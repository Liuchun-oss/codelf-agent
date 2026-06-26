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
import { collectUserContext, renderUserContext } from './context/userContext'
import { collectSystemContext, renderSystemContext } from './context/systemContext'
import { collectMemoryContext, renderMemoryContext } from './context/memoryContext'
import { collectSubagentContext, renderSubagentContext } from './context/subagentContext'
import { loadApplicableSkills, renderAvailableSkillsSection, summarizeSkill } from '../skills/loadSkills'


function permissionModeMarker(mode: PromptContext['permissionMode']): string {
  const label = mode === 'acceptEdits' ? '**Accept Edits**' : '**Default**'
  return `# Runtime context\nActive permission mode: ${label}.`
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
  const dynamicSections: string[] = filterEmpty([getPersonaSection(ctx), getLanguageSection(ctx), getMirrorsSection(ctx), getEnvSection(ctx)])
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
