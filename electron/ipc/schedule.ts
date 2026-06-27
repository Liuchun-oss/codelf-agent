// schedule:* IPC：定时任务的增删改查 / 立即运行 / 启停。
// 状态变化通过 schedule:taskUpdate / schedule:taskDeleted 广播给所有窗口（仿 channels:status）。
// 设计见 docs/定时任务功能策划书.md 第 4.3 节。

import { ipcMain, dialog, BrowserWindow } from 'electron'
import type {
  ScheduledTask,
  ScheduledTaskDraft,
  ScheduledTaskPatch
} from '@shared/scheduleTypes'
import {
  listScheduledTasks,
  createScheduledTask,
  updateScheduledTask,
  deleteTask,
  setScheduledTaskEnabled,
  runScheduledTaskNow
} from '../services/scheduleQueue'

export function registerScheduleIpc(): void {
  ipcMain.handle('schedule:list', async (): Promise<ScheduledTask[]> => listScheduledTasks())

  ipcMain.handle(
    'schedule:create',
    async (_e, draft: ScheduledTaskDraft): Promise<ScheduledTask> => createScheduledTask(draft)
  )

  ipcMain.handle(
    'schedule:update',
    async (_e, id: string, patch: ScheduledTaskPatch): Promise<ScheduledTask | null> =>
      updateScheduledTask(id, patch)
  )

  ipcMain.handle('schedule:delete', async (_e, id: string): Promise<void> => {
    deleteTask(id)
  })

  ipcMain.handle(
    'schedule:toggle',
    async (_e, id: string, enabled: boolean): Promise<ScheduledTask | null> =>
      setScheduledTaskEnabled(id, enabled)
  )

  ipcMain.handle('schedule:runNow', async (_e, id: string): Promise<{ ok: boolean }> => ({
    ok: runScheduledTaskNow(id)
  }))

  // 任务工作区文件夹选择器（仿 channels:pickWorkspace）。
  ipcMain.handle('schedule:pickWorkspace', async (e): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
}
