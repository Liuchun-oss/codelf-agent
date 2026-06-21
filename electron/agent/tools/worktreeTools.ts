import { z } from 'zod'
import type { Tool, ToolResult } from './types'
import { ENTER_WORKTREE_DESCRIPTION, ENTER_WORKTREE_NAME, EXIT_WORKTREE_DESCRIPTION, EXIT_WORKTREE_NAME } from '../prompts/tools/worktreeMode'
import { enterWorktreeSession, exitWorktreeSession } from '../orchestrator/worktreeSession'

const enterWorktreeSchema = z.object({
  name: z.string().min(1).max(64).describe('Safe worktree slug, e.g. feature-auth or experiments/ui'),
  baseRef: z.string().min(1).max(200).optional().describe('Git ref to branch from; defaults to HEAD')
})

const exitWorktreeSchema = z.object({
  remove: z.boolean().optional().describe('Remove the worktree after exiting. Only true when safe or explicitly requested.')
})

export const enterWorktreeTool: Tool<z.infer<typeof enterWorktreeSchema>> = {
  name: ENTER_WORKTREE_NAME,
  description: ENTER_WORKTREE_DESCRIPTION,
  schema: enterWorktreeSchema,
  readOnly: false,
  concurrencySafe: false,
  async execute(input, ctx): Promise<ToolResult> {
    const sessionId = ctx.sessionId || 'default'
    const result = enterWorktreeSession({
      sessionId,
      workspaceRoot: ctx.workspaceRoot,
      name: input.name,
      baseRef: input.baseRef
    })
    if ('error' in result) return { content: result.error, isError: true }
    ctx.requestWorkspaceRootChange?.(result.worktreePath, `entered_worktree:${result.worktreeName}`)
    return {
      content: [
        `已进入 worktree：${result.worktreeName}`,
        `路径：${result.worktreePath}`,
        `分支：${result.branchName}`,
        `原工作区：${result.originalWorkspaceRoot}`
      ].join('\n')
    }
  }
}

export const exitWorktreeTool: Tool<z.infer<typeof exitWorktreeSchema>> = {
  name: EXIT_WORKTREE_NAME,
  description: EXIT_WORKTREE_DESCRIPTION,
  schema: exitWorktreeSchema,
  readOnly: false,
  concurrencySafe: false,
  async execute(input, ctx): Promise<ToolResult> {
    const sessionId = ctx.sessionId || 'default'
    const result = exitWorktreeSession({ sessionId, remove: input.remove === true })
    if ('error' in result) return { content: result.error, isError: true }
    ctx.requestWorkspaceRootChange?.(result.originalWorkspaceRoot, input.remove ? 'exited_and_removed_worktree' : 'exited_worktree')
    return {
      content: [
        '已退出 worktree。',
        `当前工作区恢复为：${result.originalWorkspaceRoot}`,
        result.worktreePath ? `worktree 路径：${result.worktreePath}` : '',
        input.remove ? `已尝试删除 worktree：${result.removed ? '成功' : '失败或无需删除'}` : 'worktree 已保留。'
      ].filter(Boolean).join('\n')
    }
  }
}
