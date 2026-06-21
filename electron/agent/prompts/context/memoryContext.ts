import type { PromptContext } from '../types'
import type { ProviderKind } from '@shared/agentTypes'
import { getMemorySettings } from '../../settings/agentSettingsStore'
import {
  readMemorySnapshot,
  isMemoryEffectivelyEmpty,
  renderProjectMemoryBudgeted,
  renderGlobalMemoryBudgeted
} from '../../memory/store'

export interface MemoryContextSnapshot {
  project?: string
  global?: string
}

/**
 * 收集长期记忆（项目 + 全局）。仅在记忆系统开启且允许注入时读取。
 * 不读取会话级 checkpoint/notes —— 那些属于后续阶段的 rebuild 注入，不进 system。
 */
export async function collectMemoryContext(ctx: PromptContext): Promise<MemoryContextSnapshot> {
  const settings = getMemorySettings()
  if (!settings.enabled || !settings.injectOnNewSession) return {}

  const snap = await readMemorySnapshot(ctx.workspacePath)
  const out: MemoryContextSnapshot = {}

  const kind = providerKindFromCtx(ctx)
  const totalBudget = settings.injectBudgetTokens

  if (!isMemoryEffectivelyEmpty(snap.project)) {
    out.project = renderProjectMemoryBudgeted(snap.project as string, totalBudget, ctx.model, kind)
  }
  if (!isMemoryEffectivelyEmpty(snap.global)) {
    out.global = renderGlobalMemoryBudgeted(snap.global as string, ctx.model, kind)
  }
  return out
}

export function renderMemoryContext(snap: MemoryContextSnapshot): string | null {
  const sections: string[] = []
  if (snap.global?.trim()) {
    sections.push(snap.global.trim())
  }
  if (snap.project?.trim()) {
    sections.push(snap.project.trim())
  }
  if (sections.length === 0) return null
  return [
    '# 长期记忆',
    '',
    '以下是跨会话积累的项目知识与用户偏好，请在本会话中遵循。如与当前对话冲突，以当前用户的明确指示为准。',
    '',
    ...sections
  ].join('\n')
}

// PromptContext 未携带 providerKind，model 字段足以让 tokenCounter 选择编码；
// kind 仅在 DeepSeek 等特殊分词时用到，这里无法精确得知，传 undefined 让其回退到按 model 推断。
function providerKindFromCtx(_ctx: PromptContext): ProviderKind | undefined {
  return undefined
}
