// 微信适配器：实现 ChannelAdapter。
// 串起协议层（api/monitor/loginQr/account）与通用通道层。
// 含 #7 发送队列（保证同一会话出站顺序）、B4 分块、markdown→纯文本。

import type {
  ChannelLoginQr,
  ChannelLoginState,
  ChannelRuntimeStatus,
  ChannelConnectionStatus
} from '@shared/channelTypes'
import type { ChannelAdapter, ChannelContext, OutboundMessage, ChannelDiagnostics } from '../types'
import { sendText, sendImageMessage, getConfig, sendTyping } from './api'
import { TypingStatus } from './types'
import { uploadImageBuffer, dataUrlToBuffer } from './cdn'
import { isSilkAvailable } from './silkTranscode'
import { getInboundMediaDir } from './inboundMedia'
import { WeixinMonitor } from './monitor'
import { beginQrLogin, pollQrLogin, type QrSession } from './loginQr'
import {
  loadAccount,
  saveAccount,
  saveOwnerContextToken,
  hasAccount,
  clearAccount
} from './account'
import { markdownToPlainText, chunkText } from './markdown'
import { getChannelsSettings, saveChannelsSettings } from '../../agent/settings/agentSettingsStore'
import type { WeixinAccountState, WeixinMessage } from './types'

export class WeixinAdapter implements ChannelAdapter {
  readonly channelId = 'weixin'

  private ctx: ChannelContext | null = null
  private monitor: WeixinMonitor | null = null
  private account: WeixinAccountState | null = null
  private status: ChannelConnectionStatus = 'disconnected'
  private statusMessage: string | undefined
  private lastInboundAt: number | undefined
  private sessionCount = 0
  // 扫码登录会话缓存（sessionKey → QrSession）。
  private qrSessions = new Map<string, QrSession>()
  // #7：每会话一个串行发送队列，保证出站顺序。
  private sendQueues = new Map<string, Promise<void>>()
  // #3 兜底：缓存机主最近一次的 context_token。主动通知无入站上下文、缺 context_token，
  // 优先用这个兜底，提高送达率。
  private lastOwnerContextToken: string | undefined
  // typing_ticket 缓存（userId → ticket）。getConfig 拿一次后复用。
  private typingTickets = new Map<string, string>()
  // 正在输入保活定时器（conversationId → timer），轮次内周期性续发。
  private typingTimers = new Map<string, ReturnType<typeof setInterval>>()
  // 期望处于"正在输入"的会话集合。修复竞态：startTyping 要先 await 拿 ticket，
  // 若期间 stopTyping 已被调用（快轮次），late 的 startTyping 不应再设保活定时器。
  private typingWanted = new Set<string>()

  hasCredential(): boolean {
    return hasAccount()
  }

  getStatus(): ChannelRuntimeStatus {
    return {
      channelId: this.channelId,
      status: this.status,
      accountId: this.account?.accountId,
      lastInboundAt: this.lastInboundAt,
      sessionCount: this.sessionCount,
      message: this.statusMessage
    }
  }

  private setStatus(status: ChannelConnectionStatus, message?: string): void {
    this.status = status
    this.statusMessage = message
    this.ctx?.onStatus(this.getStatus())
  }

  // 供 manager 上报会话数（可选）。
  setSessionCount(n: number): void {
    this.sessionCount = n
  }

  async start(ctx: ChannelContext): Promise<void> {
    this.ctx = ctx
    // 防止重复启动：若已有 monitor 在跑（重新登录/重复 start），先停掉旧的，
    // 否则会出现两个长轮询循环并发拉同一 token，导致消息重复处理。
    if (this.monitor) {
      this.monitor.stop()
      this.monitor = null
    }
    const account = loadAccount()
    if (!account) {
      this.setStatus('disconnected', '尚未登录，请先扫码连接。')
      throw new Error('微信通道未登录，无法启动')
    }
    this.account = account
    // 从持久化恢复机主 context_token，供主动通知兜底（重启后仍可用，修复重启后
    // 主动推送因缺 token 被微信静默丢弃的问题）。
    if (account.lastOwnerContextToken) {
      this.lastOwnerContextToken = account.lastOwnerContextToken
    }
    this.setStatus('connecting')

    this.monitor = new WeixinMonitor(
      account.baseUrl,
      account.token,
      account.get_updates_buf,
      {
        onMessage: ({ from, text, contextToken, raw }) => {
          this.lastInboundAt = Date.now()
          this.setStatus('connected')
          // 若来自机主，缓存其 context_token 供主动通知兜底（#3），并落盘持久化，
          // 使 App 重启后主动推送仍可带 token 送达。
          if (this.account?.userId && from === this.account.userId && contextToken) {
            this.lastOwnerContextToken = contextToken
            saveOwnerContextToken(contextToken)
          }
          ctx.onInbound({
            channelId: this.channelId,
            conversationId: `wx:dm:${from}`,
            senderId: from,
            text,
            raw: { contextToken, message: raw }
          })
        },
        onExpired: () => {
          this.setStatus('expired', '微信登录已过期，请重新登录。')
        },
        onError: (m) => {
          ctx.log(m)
        },
        log: (m) => ctx.log(m)
      }
    )
    this.setStatus('connected')
    void this.monitor.run().catch((e) => {
      this.setStatus('error', String(e))
    })
  }

  async stop(): Promise<void> {
    this.monitor?.stop()
    this.monitor = null
    this.clearAllTyping()
    this.setStatus('disconnected')
  }

  // 清掉所有"正在输入"保活定时器（停机/登出时调用）。
  private clearAllTyping(): void {
    for (const t of this.typingTimers.values()) clearInterval(t)
    this.typingTimers.clear()
    this.typingWanted.clear()
  }

  async sendMessage(out: OutboundMessage, senderId: string, raw: unknown): Promise<void> {
    if (!this.account) throw new Error('微信通道未连接')
    const text = out.text ?? ''
    if (!text) return
    const plain = markdownToPlainText(text)
    const chunks = chunkText(plain, 4000)
    const contextToken = this.extractContextToken(raw)

    // #7：把本次发送排进该会话的串行队列。
    const prev = this.sendQueues.get(out.conversationId) ?? Promise.resolve()
    const next = prev.then(async () => {
      for (const chunk of chunks) {
        if (!this.account) return
        await sendText({
          baseUrl: this.account.baseUrl,
          token: this.account.token,
          to: senderId,
          text: chunk,
          contextToken
        })
      }
    })
    this.sendQueues.set(
      out.conversationId,
      next.catch(() => {})
    )
    return next
  }

  // B5：发送图片到指定接收人。dataUrl 为 data:image/...;base64 形式。
  // 走该会话的串行发送队列，保证与文本块顺序一致。失败抛出由调用方兜底降级。
  async sendImage(conversationId: string, senderId: string, dataUrl: string, raw: unknown): Promise<void> {
    if (!this.account) throw new Error('微信通道未连接')
    const buf = dataUrlToBuffer(dataUrl)
    if (!buf) throw new Error('无法解析图片数据')
    const contextToken = this.extractContextToken(raw)
    const prev = this.sendQueues.get(conversationId) ?? Promise.resolve()
    const next = prev.then(async () => {
      if (!this.account) return
      const uploaded = await uploadImageBuffer({
        baseUrl: this.account.baseUrl,
        token: this.account.token,
        toUserId: senderId,
        buf,
        log: (m) => this.ctx?.log(m)
      })
      await sendImageMessage({
        baseUrl: this.account.baseUrl,
        token: this.account.token,
        to: senderId,
        uploaded,
        contextToken
      })
    })
    this.sendQueues.set(
      conversationId,
      next.catch(() => {})
    )
    return next
  }

  private extractContextToken(raw: unknown): string | undefined {
    if (raw && typeof raw === 'object') {
      const r = raw as { contextToken?: string; message?: WeixinMessage }
      if (typeof r.contextToken === 'string') return r.contextToken
      if (r.message?.context_token) return r.message.context_token
    }
    return undefined
  }

  // 阶段3 主动通知：把消息发给机主（ilink_user_id），无入站上下文。
  // 用缓存的机主 context_token 兜底（#3 待验证：无 token 能否直发）。
  // 返回是否成功。未登录或未知机主时返回 false。
  async notify(text: string): Promise<boolean> {
    if (!this.account?.userId || !text.trim()) return false
    const plain = markdownToPlainText(text)
    const chunks = chunkText(plain, 4000)
    try {
      for (const chunk of chunks) {
        await sendText({
          baseUrl: this.account.baseUrl,
          token: this.account.token,
          to: this.account.userId,
          text: chunk,
          contextToken: this.lastOwnerContextToken
        })
      }
      return true
    } catch (e) {
      this.ctx?.log(`主动通知发送失败：${String(e)}`)
      return false
    }
  }

  // 是否具备主动通知能力（已登录且知道机主 id）。
  canNotify(): boolean {
    return Boolean(this.account?.userId)
  }

  // /diag 自检信息。
  async getDiagnostics(): Promise<ChannelDiagnostics> {
    const userId = this.account?.userId
    return {
      typingTicketCached: Boolean(userId && this.typingTickets.has(userId)),
      silkAvailable: await isSilkAvailable(),
      inboundDir: getInboundMediaDir()
    }
  }

  // 主动给机主发送一张图片（data:image/...;base64）。返回是否成功。
  async notifyImage(dataUrl: string): Promise<boolean> {
    if (!this.account?.userId) return false
    const buf = dataUrlToBuffer(dataUrl)
    if (!buf) return false
    try {
      const uploaded = await uploadImageBuffer({
        baseUrl: this.account.baseUrl,
        token: this.account.token,
        toUserId: this.account.userId,
        buf,
        log: (m) => this.ctx?.log(m)
      })
      await sendImageMessage({
        baseUrl: this.account.baseUrl,
        token: this.account.token,
        to: this.account.userId,
        uploaded,
        contextToken: this.lastOwnerContextToken
      })
      return true
    } catch (e) {
      this.ctx?.log(`主动图片通知发送失败：${String(e)}`)
      return false
    }
  }

  // --- "正在输入"状态（B：边想边显示输入中）---

  // 取某用户的 typing_ticket（缓存复用）。失败返回 undefined。
  private async resolveTypingTicket(userId: string, contextToken?: string): Promise<string | undefined> {
    const cached = this.typingTickets.get(userId)
    if (cached) return cached
    if (!this.account) return undefined
    try {
      const cfg = await getConfig({
        baseUrl: this.account.baseUrl,
        token: this.account.token,
        ilinkUserId: userId,
        contextToken
      })
      const ticket = cfg.typing_ticket?.trim()
      if (ticket) {
        this.typingTickets.set(userId, ticket)
        return ticket
      }
    } catch (e) {
      this.ctx?.log(`获取 typing_ticket 失败：${String(e)}`)
    }
    return undefined
  }

  // 开始"正在输入"，并每 5 秒续发保活，直到 stopTyping。
  async startTyping(conversationId: string, userId: string, contextToken?: string): Promise<void> {
    if (!this.account) return
    // 标记本会话期望输入中。await 拿 ticket 期间若被 stopTyping 清除，则放弃设定时器。
    this.typingWanted.add(conversationId)
    const ticket = await this.resolveTypingTicket(userId, contextToken)
    if (!ticket) return
    // 竞态修复：拿 ticket 期间轮次已结束（stopTyping 调用过）→ 不再启动保活。
    if (!this.typingWanted.has(conversationId)) return
    const send = (status: number): void => {
      if (!this.account) return
      void sendTyping({
        baseUrl: this.account.baseUrl,
        token: this.account.token,
        ilinkUserId: userId,
        typingTicket: ticket,
        status
      }).catch(() => {})
    }
    send(TypingStatus.TYPING)
    // 清掉旧定时器再设新的，避免叠加。
    const old = this.typingTimers.get(conversationId)
    if (old) clearInterval(old)
    this.typingTimers.set(
      conversationId,
      setInterval(() => send(TypingStatus.TYPING), 5000)
    )
  }

  // 停止"正在输入"。
  stopTyping(conversationId: string, userId: string): void {
    this.typingWanted.delete(conversationId)
    const timer = this.typingTimers.get(conversationId)
    if (timer) {
      clearInterval(timer)
      this.typingTimers.delete(conversationId)
    }
    const ticket = this.typingTickets.get(userId)
    if (this.account && ticket) {
      void sendTyping({
        baseUrl: this.account.baseUrl,
        token: this.account.token,
        ilinkUserId: userId,
        typingTicket: ticket,
        status: TypingStatus.CANCEL
      }).catch(() => {})
    }
  }

  // --- 扫码登录 ---

  async beginLogin(): Promise<ChannelLoginQr> {
    const session = await beginQrLogin()
    const sessionKey = `wx-login-${Date.now()}-${Math.random().toString(36).slice(2)}`
    this.qrSessions.set(sessionKey, session)
    this.setStatus('connecting', '等待扫码…')
    return { qrcodeUrl: session.qrcodeImg, sessionKey }
  }

  async pollLogin(sessionKey: string): Promise<ChannelLoginState> {
    const session = this.qrSessions.get(sessionKey)
    if (!session) return { status: 'error', message: '登录会话不存在，请重新发起。' }
    try {
      const r = await pollQrLogin(session)
      switch (r.status) {
        case 'wait':
          return { status: 'wait' }
        case 'scanned':
          return { status: 'scanned' }
        case 'expired':
          this.qrSessions.delete(sessionKey)
          return { status: 'expired' }
        case 'confirmed': {
          this.qrSessions.delete(sessionKey)
          saveAccount(r.account)
          this.account = r.account
          // 首次连接成功后自动开启通道开关（7.6.3 步骤 7）。
          saveChannelsSettings({ weixin: { ...getChannelsSettings().weixin, enabled: true } })
          // 注意：长轮询由 ChannelManager.start() 拉起（它负责构造 ctx），
          // 这里不自行 start——首次登录时 this.ctx 尚为 null，自启会失败。
          return { status: 'confirmed', accountId: r.account.accountId }
        }
        default:
          return { status: 'wait' }
      }
    } catch (e) {
      return { status: 'error', message: e instanceof Error ? e.message : String(e) }
    }
  }

  async logout(): Promise<void> {
    this.monitor?.stop()
    this.monitor = null
    this.clearAllTyping()
    this.typingTickets.clear()
    this.account = null
    clearAccount()
    saveChannelsSettings({ weixin: { ...getChannelsSettings().weixin, enabled: false } })
    this.setStatus('disconnected')
  }
}
