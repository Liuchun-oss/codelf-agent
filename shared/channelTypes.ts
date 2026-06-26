// 通讯通道（Channels）配置类型与默认值。
// 当前仅实现微信（weixin）适配器，结构上预留多平台扩展位。
// 见 docs/微信通讯接入策划书.md 第 6/7 节。

export type ChannelConnectionStatus =
  | 'disconnected' // 未连接
  | 'connecting' // 扫码登录中
  | 'connected' // 已连接、长轮询在线
  | 'expired' // 凭证失效（errcode -14），需重新登录
  | 'error' // 运行出错

// 微信 agent 的「人格定义（出厂设置）」。首次接入时引导用户定义，
// 之后作为永久系统提示词注入到每一轮（仅微信会话生效，不影响桌面端 UI 的 Agent）。
export interface WeixinPersona {
  // 是否已完成首次激活。false 时下一条入站消息会触发引导式问答。
  activated: boolean
  // AI 自己的名字（「我叫什么」）。
  selfName: string
  // 主人的名字（「你叫什么」）。
  ownerName: string
  // 希望 AI 怎么称呼主人（如「主人」「老板」「阿杰」）。
  addressing: string
  // 身份定义 / 说话风格 / 语气 / 性格的自由描述。
  style: string
  // 激活完成的时间戳（ms），便于排查/展示。
  activatedAt?: number
}

export const DEFAULT_WEIXIN_PERSONA: WeixinPersona = {
  activated: false,
  selfName: '',
  ownerName: '',
  addressing: '',
  style: ''
}

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
  // 微信 agent 人格定义（出厂设置）。
  persona: WeixinPersona
}

export const DEFAULT_WEIXIN_CHANNEL_SETTINGS: WeixinChannelSettings = {
  enabled: false,
  workspaceRoot: '',
  mergeWindowEnabled: true,
  riskAcknowledged: false,
  persona: { ...DEFAULT_WEIXIN_PERSONA }
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
    riskAcknowledged: typeof p.riskAcknowledged === 'boolean' ? p.riskAcknowledged : d.riskAcknowledged,
    persona: normalizeWeixinPersona(p.persona)
  }
}

export function normalizeWeixinPersona(
  partial: Partial<WeixinPersona> | undefined
): WeixinPersona {
  const d = DEFAULT_WEIXIN_PERSONA
  const p = partial ?? {}
  const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v.trim() : fallback)
  return {
    activated: typeof p.activated === 'boolean' ? p.activated : d.activated,
    selfName: str(p.selfName, d.selfName),
    ownerName: str(p.ownerName, d.ownerName),
    addressing: str(p.addressing, d.addressing),
    style: str(p.style, d.style),
    ...(typeof p.activatedAt === 'number' ? { activatedAt: p.activatedAt } : {})
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
