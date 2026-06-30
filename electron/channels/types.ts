// 通用通道层接口定义。微信只是它的第一个实现，结构预留多平台扩展。
// 见策划书第 7 节。

import type { ChannelLoginQr, ChannelLoginState, ChannelRuntimeStatus } from '@shared/channelTypes'

// 入站消息：各平台归一化后的统一结构。
export interface InboundMessage {
  channelId: string
  // 统一会话标识，如 'wx:dm:<userId>'。
  conversationId: string
  // 平台内发送者 id（回信目标）。
  senderId: string
  text: string
  // 平台原始消息（context_token 等放这里）。
  raw: unknown
}

// 出站消息。
export interface OutboundMessage {
  conversationId: string
  text?: string
}

// 适配器运行所需的回调上下文（由 ChannelManager 提供）。
export interface ChannelContext {
  // 收到入站消息时回调，ChannelManager 据此驱动 QueryEngine。
  onInbound: (msg: InboundMessage) => void
  // 运行态变化时回调（连接/失效/错误等），ChannelManager 上报给 UI。
  onStatus: (status: ChannelRuntimeStatus) => void
  log: (m: string) => void
}

// 通道适配器：每个 IM 平台实现一份。
export interface ChannelAdapter {
  readonly channelId: string
  // 启动监听（长轮询/长连接）。需已有有效凭证。
  start(ctx: ChannelContext): Promise<void>
  stop(): Promise<void>
  // 发送出站消息。senderId 为回信目标，raw 为入站原始消息（取 context_token）。
  sendMessage(out: OutboundMessage, senderId: string, raw: unknown): Promise<void>
  // 可选（B5）：发送图片。dataUrl 为 data:image/...;base64 形式。仅支持图片的平台实现。
  sendImage?(conversationId: string, senderId: string, dataUrl: string, raw: unknown): Promise<void>
  // 可选：发送文件（文档/压缩包等）。filePath 为本地绝对路径，fileName 为展示名。仅支持文件的平台实现。
  sendFile?(
    conversationId: string,
    senderId: string,
    filePath: string,
    fileName: string,
    raw: unknown
  ): Promise<void>
  // 可选：开始/停止"正在输入"状态。raw 用于取 context_token（getConfig 拿 ticket）。
  startTyping?(conversationId: string, senderId: string, contextToken?: string): Promise<void>
  stopTyping?(conversationId: string, senderId: string): void
  // 登录相关（微信扫码）。
  beginLogin(): Promise<ChannelLoginQr>
  pollLogin(sessionKey: string): Promise<ChannelLoginState>
  // 断开并清除凭证。
  logout(): Promise<void>
  getStatus(): ChannelRuntimeStatus
  // 是否已有持久化凭证（决定 UI 显示"连接"还是"已连接"）。
  hasCredential(): boolean
  // 可选：由 ChannelManager 同步当前活跃会话数，供运行信息展示。
  setSessionCount?(n: number): void
  // 可选：是否具备主动通知能力（已登录且知道机主 id）。
  canNotify?(): boolean
  // 可选（/diag 自检）：返回运行诊断信息。
  getDiagnostics?(): Promise<ChannelDiagnostics>
}

// /diag 自检信息。
export interface ChannelDiagnostics {
  // typing_ticket 是否已缓存。
  typingTicketCached: boolean
  // silk 转码（silk-wasm）是否可用。
  silkAvailable: boolean
  // 入站媒体落盘目录。
  inboundDir: string
}
