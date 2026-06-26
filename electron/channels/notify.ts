// 阶段3 主动通知：供 Codelf 各处长任务回调调用，把完成/出错消息推到微信机主。
// 见策划书第 8 节阶段3 / 7.7 #3。
// 失败降级：未登录、未启用、协议失败时静默返回 false，绝不影响主流程。

import { getWeixinAdapter } from './index'
import { getChannelsSettings } from '../agent/settings/agentSettingsStore'

// 推一条通知给微信机主。返回是否送达。
export async function notifyWeixin(text: string): Promise<boolean> {
  try {
    if (!getChannelsSettings().weixin.enabled) return false
    const adapter = getWeixinAdapter()
    if (!adapter.canNotify()) return false
    return await adapter.notify(text)
  } catch {
    return false
  }
}

// 主动推一张图片给微信机主（B5）。dataUrl 为 data:image/...;base64 形式。返回是否送达。
export async function notifyWeixinImage(dataUrl: string): Promise<boolean> {
  try {
    if (!getChannelsSettings().weixin.enabled) return false
    const adapter = getWeixinAdapter()
    if (!adapter.canNotify()) return false
    return await adapter.notifyImage(dataUrl)
  } catch {
    return false
  }
}
