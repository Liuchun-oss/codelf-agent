import { ipcMain } from 'electron'
import {
  getStatus,
  getDiffContent,
  stage,
  unstage,
  stageAll,
  unstageAll,
  discardChanges,
  commit,
  listBranches,
  checkoutBranch,
  push,
  pull,
  getStagedDiffForAi
} from '../services/gitService'
import { generateCommitMessage } from '../agent/orchestrator/commitMessage'
import type { GitFileStatus } from '@shared/gitTypes'

export function registerGitIpc(): void {
  ipcMain.handle('git:status', (_e, cwd: string) => getStatus(cwd))

  ipcMain.handle('git:diff', (_e, cwd: string, path: string, staged: boolean) =>
    getDiffContent(cwd, path, staged)
  )

  ipcMain.handle('git:stage', (_e, cwd: string, paths: string[]) => stage(cwd, paths))
  ipcMain.handle('git:unstage', (_e, cwd: string, paths: string[]) => unstage(cwd, paths))
  ipcMain.handle('git:stageAll', (_e, cwd: string) => stageAll(cwd))
  ipcMain.handle('git:unstageAll', (_e, cwd: string) => unstageAll(cwd))

  ipcMain.handle(
    'git:discard',
    (_e, cwd: string, change: { path: string; status: GitFileStatus }) =>
      discardChanges(cwd, change)
  )

  ipcMain.handle('git:commit', (_e, cwd: string, message: string, amend: boolean) =>
    commit(cwd, message, amend)
  )

  ipcMain.handle('git:listBranches', (_e, cwd: string) => listBranches(cwd))
  ipcMain.handle('git:checkoutBranch', (_e, cwd: string, name: string, create: boolean) =>
    checkoutBranch(cwd, name, create)
  )

  ipcMain.handle('git:push', (_e, cwd: string) => push(cwd))
  ipcMain.handle('git:pull', (_e, cwd: string) => pull(cwd))

  ipcMain.handle('git:generateMessage', async (_e, cwd: string) => {
    const diff = await getStagedDiffForAi(cwd)
    if (!diff.trim()) return { ok: false, error: '没有已暂存的更改可供生成信息' }
    return generateCommitMessage(diff)
  })
}
