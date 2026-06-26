// 通道层启动入口：注册适配器、按配置自动启动、上报会话数。

import { getChannelManager } from './manager'
import { WeixinAdapter } from './weixin/adapter'
import { getChannelsSettings } from '../agent/settings/agentSettingsStore'

let weixinAdapter: WeixinAdapter | null = null
let initialized = false

export function getWeixinAdapter(): WeixinAdapter {
  if (!weixinAdapter) weixinAdapter = new WeixinAdapter()
  return weixinAdapter
}

// 主进程启动时调用：注册微信适配器，并在"已启用且已登录"时自动开始长轮询。
export async function initChannels(): Promise<void> {
  if (initialized) return
  initialized = true
  const manager = getChannelManager()
  const adapter = getWeixinAdapter()
  manager.register(adapter)

  const settings = getChannelsSettings().weixin
  if (settings.enabled && adapter.hasCredential()) {
    try {
      await manager.start('weixin')
      // C9：启动后检查上次是否有被重启中断的会话，有则提示机主。
      await manager.recoverStaleSessions()
      // 若人格尚未激活，主动推一条开场白请用户定义身份（已激活则跳过）。
      void manager.greetForActivation()
    } catch (e) {
      console.error('[channels] 微信通道自动启动失败：', e)
    }
  }
}
