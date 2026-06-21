import type { PromptContext } from '../types'
import { collectGitContext, renderGitContext, type GitContextSnapshot } from '../../context/gitContext'



export interface SystemContextSnapshot {
  git: GitContextSnapshot
}

export async function collectSystemContext(
  ctx: PromptContext,
  signal?: AbortSignal
): Promise<SystemContextSnapshot> {
  const git = await collectGitContext(ctx.workspacePath, signal)
  return { git }
}

export function renderSystemContext(snap: SystemContextSnapshot): string | null {
  return renderGitContext(snap.git)
}
