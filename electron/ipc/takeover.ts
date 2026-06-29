// 接管模式 IPC：渲染层查询状态、HUD 停止按钮。
// 进入接管由 agent 工具 EnterDesktopTakeover 自主触发，不再由渲染层发起。
import { ipcMain } from 'electron'
import { exitTakeover, getTakeoverState } from '../services/takeover/takeoverController'
import { resizeHud } from '../services/takeover/overlayWindows'

export function registerTakeoverIpc(): void {
  // HUD 停止按钮触发；其余退出路径（ESC/看门狗/agent 主动退出）由控制器内部处理。
  ipcMain.handle('takeover:stop', async (): Promise<boolean> => {
    await exitTakeover('user', { cancelAgent: true })
    return true
  })

  ipcMain.handle('takeover:state', async () => getTakeoverState())

  // HUD 内容高度变化时自适应窗口高度。
  ipcMain.on('takeover:resizeHud', (_e, height: number) => {
    if (typeof height === 'number' && Number.isFinite(height)) resizeHud(height)
  })
}
