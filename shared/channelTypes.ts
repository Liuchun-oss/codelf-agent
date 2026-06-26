// 通讯通道（Channels）配置类型与默认值。
// 当前仅实现微信（weixin）适配器，结构上预留多平台扩展位。
// 见 docs/微信通讯接入策划书.md 第 6/7 节。

export type ChannelConnectionStatus =
  | 'disconnected' // 未连接
  | 'connecting' // 扫码登录中
  | 'connected' // 已连接、长轮询在线
  | 'expired' // 凭证失效（errcode -14），需重新登录
  | 'error' // 运行出错

export interface WeixinChannelSettings {
  // 是否启用微信通道。初始默认关（实验性，用户主动开）；
  // 首次扫码连接成功后自动置为 true（见策划书 7.6.3 步骤 7）。
  enabled: boolean
  // 微信会话专属工作区（sessionCwd 的默认起点）。空字符串=未配置，降级为纯对话。
  workspaceRoot: string
  // A3：3 秒合并窗口开关，默认开。
  mergeWindowEnabled: boolean
  // 用户是否已确认实验性功能风险（首次连接前必须勾选，见 11.5）。
  riskAcknowledged: boolean
}

export const DEFAULT_WEIXIN_CHANNEL_SETTINGS: WeixinChannelSettings = {
  enabled: false,
  workspaceRoot: '',
  mergeWindowEnabled: true,
  riskAcknowledged: false
}

export interface ChannelsSettings {
  weixin: WeixinChannelSettings
}

export const DEFAULT_CHANNELS_SETTINGS: ChannelsSettings = {
  weixin: { ...DEFAULT_WEIXIN_CHANNEL_SETTINGS }
}

export function normalizeWeixinChannelSettings(
  partial: Partial<WeixinChannelSettings> | undefined
): WeixinChannelSettings {
  const d = DEFAULT_WEIXIN_CHANNEL_SETTINGS
  const p = partial ?? {}
  return {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : d.enabled,
    workspaceRoot: typeof p.workspaceRoot === 'string' ? p.workspaceRoot.trim() : d.workspaceRoot,
    mergeWindowEnabled:
      typeof p.mergeWindowEnabled === 'boolean' ? p.mergeWindowEnabled : d.mergeWindowEnabled,
    riskAcknowledged: typeof p.riskAcknowledged === 'boolean' ? p.riskAcknowledged : d.riskAcknowledged
  }
}

export function normalizeChannelsSettings(
  partial: Partial<ChannelsSettings> | undefined
): ChannelsSettings {
  return {
    weixin: normalizeWeixinChannelSettings(partial?.weixin)
  }
}

// 通道运行态（供设置 UI 展示），由主进程实时上报。
export interface ChannelRuntimeStatus {
  channelId: string
  status: ChannelConnectionStatus
  // 已连接时的展示信息（账号 id / 昵称）。
  accountId?: string
  // 最近一次收到入站消息的时间戳（ms）。
  lastInboundAt?: number
  // 当前活跃会话数。
  sessionCount: number
  // 最近一条错误/提示（供 UI 排查）。
  message?: string
}

// 扫码登录：beginLogin 返回。
export interface ChannelLoginQr {
  // 二维码图片内容/链接（前端渲染成图）。
  qrcodeUrl: string
  // 本次登录会话 key，供 waitLogin 轮询。
  sessionKey: string
}

// 扫码登录状态轮询结果（waitLogin 每次返回）。
export interface ChannelLoginState {
  status: 'wait' | 'scanned' | 'confirmed' | 'expired' | 'error'
  accountId?: string
  message?: string
}
