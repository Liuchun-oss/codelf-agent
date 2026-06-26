// 微信扫码登录流程。复刻自阶段 0 验证脚本 probe.mjs 的 login()。
// 见策划书 4.2 / 7.6.4。这里把"拿二维码"和"轮询状态"拆成两个可被 IPC 调用的步骤，
// 以便渲染进程渲染二维码并实时刷新状态。

import { fetchQrCode, pollQrStatus, FIXED_BASE_URL } from './api'
import type { WeixinAccountState } from './types'

export interface QrSession {
  qrcode: string
  qrcodeImg: string
  // 轮询时跟随 IDC 重定向后的主机。
  baseUrl: string
  createdAt: number
}

// 第一步：拿二维码，建立一次登录会话。
export async function beginQrLogin(): Promise<QrSession> {
  const qr = await fetchQrCode()
  if (!qr?.qrcode || !qr?.qrcode_img_content) {
    throw new Error(`获取二维码失败：${JSON.stringify(qr)}`)
  }
  return {
    qrcode: qr.qrcode,
    qrcodeImg: qr.qrcode_img_content,
    baseUrl: FIXED_BASE_URL,
    createdAt: Date.now()
  }
}

export type QrPollResult =
  | { status: 'wait' }
  | { status: 'scanned' }
  | { status: 'expired' }
  | { status: 'confirmed'; account: WeixinAccountState }

// 第二步：轮询一次扫码状态。session.baseUrl 会在 IDC 重定向时被原地更新。
export async function pollQrLogin(session: QrSession): Promise<QrPollResult> {
  const st = await pollQrStatus(session.baseUrl, session.qrcode)
  switch (st.status) {
    case 'wait':
      return { status: 'wait' }
    case 'scaned':
      return { status: 'scanned' }
    case 'scaned_but_redirect':
      if (st.redirect_host) session.baseUrl = `https://${st.redirect_host}`
      return { status: 'scanned' }
    case 'expired':
      return { status: 'expired' }
    case 'confirmed': {
      if (!st.ilink_bot_id || !st.bot_token) {
        throw new Error('登录确认但缺少 bot_token / ilink_bot_id')
      }
      const account: WeixinAccountState = {
        token: st.bot_token,
        accountId: st.ilink_bot_id,
        userId: st.ilink_user_id,
        baseUrl: st.baseurl || FIXED_BASE_URL,
        get_updates_buf: '',
        savedAt: new Date().toISOString()
      }
      return { status: 'confirmed', account }
    }
    default:
      return { status: 'wait' }
  }
}
