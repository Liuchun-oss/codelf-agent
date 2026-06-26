// channels:* IPC：扫码登录 / 状态 / 启停 / 配置 / 工作区选择。
// 见策划书 7.6。

import { ipcMain, dialog, BrowserWindow } from 'electron'
import type {
  ChannelLoginQr,
  ChannelLoginState,
  ChannelRuntimeStatus,
  ChannelsSettings,
  WeixinChannelSettings
} from '@shared/channelTypes'
import { getChannelManager } from '../channels/manager'
import { getWeixinAdapter } from '../channels/index'
import { getChannelsSettings, saveChannelsSettings } from '../agent/settings/agentSettingsStore'

export function registerChannelsIpc(): void {
  const manager = getChannelManager()

  // 把通道运行态变化实时推给所有渲染窗口。
  manager.onStatus((status) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('channels:status', status)
    }
  })

  ipcMain.handle('channels:getSettings', async (): Promise<ChannelsSettings> =>
    getChannelsSettings()
  )

  ipcMain.handle(
    'channels:saveWeixinSettings',
    async (_e, patch: Partial<WeixinChannelSettings>): Promise<ChannelsSettings> => {
      const current = getChannelsSettings()
      const next = saveChannelsSettings({ weixin: { ...current.weixin, ...(patch ?? {}) } })
      // 启用开关变化时联动启停长轮询。
      const adapter = getWeixinAdapter()
      const wasEnabled = current.weixin.enabled
      if (next.weixin.enabled && !wasEnabled && adapter.hasCredential()) {
        try {
          await manager.start('weixin')
        } catch (e) {
          console.error('[channels] 启动失败：', e)
        }
      } else if (!next.weixin.enabled && wasEnabled) {
        await manager.stop('weixin')
      }
      return next
    }
  )

  ipcMain.handle('channels:getStatus', async (_e, channelId: string): Promise<ChannelRuntimeStatus | null> => {
    return manager.getStatus(channelId || 'weixin') ?? null
  })

  ipcMain.handle('channels:beginLogin', async (): Promise<ChannelLoginQr> => {
    return getWeixinAdapter().beginLogin()
  })

  ipcMain.handle(
    'channels:pollLogin',
    async (_e, sessionKey: string): Promise<ChannelLoginState> => {
      const result = await getWeixinAdapter().pollLogin(sessionKey)
      // 登录确认成功 → 由 manager 拉起长轮询（构造 ctx），状态切到「已连接」。
      if (result.status === 'confirmed') {
        try {
          await manager.start('weixin')
          // 首次连接主动开场：未激活人格时推一条开场白，直接请用户定义身份。
          void manager.greetForActivation()
        } catch (e) {
          console.error('[channels] 登录后启动长轮询失败：', e)
        }
      }
      return result
    }
  )

  ipcMain.handle('channels:logout', async (): Promise<{ ok: boolean }> => {
    await getWeixinAdapter().logout()
    return { ok: true }
  })

  // 阶段3：测试主动通知（验证无 context_token 能否直发机主，见 7.7 #3）。
  ipcMain.handle('channels:testNotify', async (): Promise<{ ok: boolean }> => {
    const ok = await getWeixinAdapter().notify('🔔 这是一条来自 Codelf 的测试通知。')
    return { ok }
  })

  ipcMain.handle('channels:start', async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      await manager.start('weixin')
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('channels:stop', async (): Promise<{ ok: boolean }> => {
    await manager.stop('weixin')
    return { ok: true }
  })

  // 专属工作区文件夹选择器。
  ipcMain.handle('channels:pickWorkspace', async (e): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
}
