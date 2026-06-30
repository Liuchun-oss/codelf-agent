// ChannelManager：把入站消息接到 QueryEngine，并把事件流翻译回 IM。
// 覆盖策划书：会话路由(6.4)、专属工作区(6.5)、项目记忆(6.6)、
// 状态机(7.7#1)、斜杠命令、A1 忙提示、A3 合并窗口、#7 发送队列。

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import type { AiSendPayload, PermissionDecision, FileChangeDecision, ImageAttachment } from '@shared/agentTypes'
import type { ChannelRuntimeStatus } from '@shared/channelTypes'
import { getQueryEngine } from '../agent/orchestrator/queryEngine'
import { loadSession, saveSession, deleteSessionFile } from '../agent/orchestrator/sessionPersistence'
import { ensureProjectMemory } from '../agent/memory/store'
import { promoteSessionMemory } from '../agent/memory/memoryPromotion'
import { getChannelsSettings, getPermissionMode, saveChannelsSettings } from '../agent/settings/agentSettingsStore'
import { getActiveProfileId } from '../agent/providers/profileStore'
import type { ChannelAdapter, ChannelContext, InboundMessage } from './types'
import { SessionBridge } from './sessionBridge'
import { markActive, clearActive, takeStaleActive } from './pendingState'
import { readArtifactFile } from '../services/artifactFileServer'
import { readBrowserPreview } from '../services/browserPreviewImage'
import { processInboundMedia } from './weixin/inboundMedia'
import type { WeixinMessage } from './weixin/types'

const MERGE_WINDOW_MS = 3000
// C10：确认请求超时（5 分钟无人回复 → 按拒绝/取消处理，释放占用）。
const CONFIRM_TIMEOUT_MS = 5 * 60_000
// 记忆自动晋升：每完成 N 轮触发一次（6.6 第4点，避免每轮都搬造成噪声）。
const PROMOTE_EVERY_N_TURNS = 5

// 每个会话的运行态（状态机基础）。
interface SessionState {
  conversationId: string
  senderId: string
  // 该会话所属通道 id（用于按会话回查 adapter，如延迟工具发文件）。
  channelId: string
  // 回信用的最近 raw 消息（取 context_token）。
  lastRaw: unknown
  // 引擎是否正在跑一轮。
  busy: boolean
  // 待回复的权限请求（阶段2）。
  pendingPermission?: { requestId: string }
  // 待回复的提问（阶段2）。
  pendingQuestion?: { requestId: string }
  // 待回复的文件改动确认（阶段2）。default 模式下引擎会阻塞等待 accept/reject。
  pendingFileChange?: { changeId: string }
  // A3 合并窗口：缓存待合并的消息（文字+原始消息，媒体下载推迟到窗口结束再做）。
  mergeBuffer: { text: string; raw: unknown }[]
  mergeTimer?: ReturnType<typeof setTimeout>
  // 通道层管理的"当前工作区"（#2：/cwd 不写引擎 override）。
  currentWorkspace: string | null
  // C10：确认超时定时器（权限/提问/文件改动无人回复时自动按拒绝处理）。
  confirmTimer?: ReturnType<typeof setTimeout>
  // 记忆晋升频率控制：累计完成的轮次数，每 N 轮触发一次自动晋升（6.6 第4点）。
  turnsSincePromote: number
  // 是否已尝试从磁盘恢复历史（跨重启续接，6.6）。每会话只恢复一次。
  restored: boolean
  // 阶段4：本会话累积的入站图片（多模态视觉内容），runTurn 消费后清空。
  pendingImages: ImageAttachment[]
  // 中止代次：/stop、/new 自增；媒体下载等异步前置会校验它是否变化，
  // 变了说明期间被中止，放弃起轮（修复"下载途中 /stop 拦不住"）。
  abortGeneration: number
}

export class ChannelManager {
  private adapters = new Map<string, ChannelAdapter>()
  private sessions = new Map<string, SessionState>()
  private statusListeners = new Set<(s: ChannelRuntimeStatus) => void>()
  private lastStatus = new Map<string, ChannelRuntimeStatus>()

  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.channelId, adapter)
  }

  onStatus(listener: (s: ChannelRuntimeStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  getAdapter(channelId: string): ChannelAdapter | undefined {
    return this.adapters.get(channelId)
  }

  getStatus(channelId: string): ChannelRuntimeStatus | undefined {
    return this.lastStatus.get(channelId) ?? this.adapters.get(channelId)?.getStatus()
  }

  private buildContext(adapter: ChannelAdapter): ChannelContext {
    return {
      onInbound: (msg) => void this.handleInbound(adapter, msg),
      onStatus: (status) => {
        this.lastStatus.set(status.channelId, status)
        for (const l of this.statusListeners) l(status)
      },
      log: (m) => console.log(`[channel:${adapter.channelId}] ${m}`)
    }
  }

  async start(channelId: string): Promise<void> {
    const adapter = this.adapters.get(channelId)
    if (!adapter) throw new Error(`未知通道：${channelId}`)
    await adapter.start(this.buildContext(adapter))
  }

  async stop(channelId: string): Promise<void> {
    const adapter = this.adapters.get(channelId)
    if (!adapter) return
    await adapter.stop()
  }

  async stopAll(): Promise<void> {
    for (const id of this.adapters.keys()) {
      try {
        await this.stop(id)
      } catch {
        // ignore
      }
    }
  }

  private getSession(msg: InboundMessage): SessionState {
    let s = this.sessions.get(msg.conversationId)
    if (!s) {
      s = {
        conversationId: msg.conversationId,
        senderId: msg.senderId,
        channelId: msg.channelId,
        lastRaw: msg.raw,
        busy: false,
        mergeBuffer: [],
        currentWorkspace: this.resolveWorkspace(),
        turnsSincePromote: 0,
        restored: false,
        pendingImages: [],
        abortGeneration: 0
      }
      this.sessions.set(msg.conversationId, s)
      // 6.6：跨重启续接——首次见到该会话时，从磁盘恢复引擎历史（若有）。
      this.restoreSessionHistory(s)
    }
    s.senderId = msg.senderId
    s.channelId = msg.channelId
    s.lastRaw = msg.raw
    return s
  }

  // 6.5：解析专属工作区；未配置返回 null（降级纯对话）。
  private resolveWorkspace(): string | null {
    const ws = getChannelsSettings().weixin.workspaceRoot
    return ws && ws.trim() ? ws.trim() : null
  }

  // 6.6：从磁盘恢复该会话的引擎历史（跨重启续接）。每会话只做一次。
  private restoreSessionHistory(session: SessionState): void {
    if (session.restored) return
    session.restored = true
    try {
      const persisted = loadSession(this.persistId(session.conversationId))
      if (persisted && persisted.history.length > 0) {
        getQueryEngine(session.conversationId).restoreHistory(
          persisted.history.map((m) => ({
            role: m.role,
            content: m.content,
            ...(m.toolCalls?.length ? { toolCalls: m.toolCalls } : {}),
            ...(m.toolCallId ? { toolCallId: m.toolCallId } : {})
          })),
          persisted.replacementRecords,
          persisted.discoveredDeferredTools
        )
      }
    } catch {
      // best-effort：恢复失败按空历史继续。
    }
  }

  // 把 conversationId（含冒号，如 wx:dm:xxx）转成 sessionPersistence 接受的安全 id
  // （仅 [A-Za-z0-9_-]）。否则 save/load 会因 isSafeId 校验静默失败。
  private persistId(conversationId: string): string {
    return conversationId.replace(/[^A-Za-z0-9_-]/g, '_')
  }

  // 一轮结束后把会话落盘，供下次重启续接。best-effort。
  private persistSession(session: SessionState): void {
    try {
      const engine = getQueryEngine(session.conversationId)
      const history = engine.exportHistoryMessages()
      if (history.length === 0) return
      const now = Date.now()
      saveSession({
        id: this.persistId(session.conversationId),
        title: `微信 ${session.senderId}`,
        createdAt: now,
        updatedAt: now,
        workspaceId: session.currentWorkspace ?? null,
        messages: [],
        history,
        replacementRecords: engine.exportContentReplacementRecords(),
        discoveredDeferredTools: engine.exportDiscoveredDeferredTools()
      })
    } catch {
      // best-effort
    }
  }

  get sessionCount(): number {
    return this.sessions.size
  }

  // C9：启动后调用。若有上次未正常结束的会话（崩溃/退出导致），
  // 给机主发提示——这些会话的内存确认/轮次已失效，请重发指令。
  async recoverStaleSessions(): Promise<void> {
    const stale = takeStaleActive()
    if (stale.length === 0) return
    const adapter = this.adapters.get('weixin')
    if (!adapter || !adapter.hasCredential()) return
    const notifiable = adapter as ChannelAdapter & { notify?: (t: string) => Promise<boolean> }
    if (typeof notifiable.notify !== 'function') return
    try {
      await notifiable.notify('上一个操作因 Codelf 重启已中断，请重发指令。')
    } catch {
      // ignore
    }
  }

  // 首次连接后主动开场：若微信 agent 尚未完成人格激活，由通道层直接推一条
  // 固定开场白（不依赖模型，确保 100% 先开口）。已激活或缺能力则跳过。
  // 区分有无模型给不同引导语。返回是否成功推送。
  async greetForActivation(): Promise<boolean> {
    const adapter = this.adapters.get('weixin')
    if (!adapter || !adapter.hasCredential()) return false
    const notifiable = adapter as ChannelAdapter & {
      notify?: (t: string) => Promise<boolean>
      canNotify?: () => boolean
    }
    if (typeof notifiable.notify !== 'function') return false
    if (notifiable.canNotify && !notifiable.canNotify()) return false
    // 已激活就不再打扰。
    if (getChannelsSettings().weixin.persona.activated) return false
    const hasModel = Boolean(getActiveProfileId())
    const text = hasModel
      ? [
          '你好呀，初来乍到，这是我第一次和你连上。',
          '我还是一张白纸，想请你帮我完成「出厂设置」，给我一个身份：',
          '· 我叫什么名字？',
          '· 你叫什么、希望我怎么称呼你？',
          '· 你希望我是怎样的性格、用什么语气和你说话？',
          '可以一次说完，也可以慢慢告诉我。准备好就回我一句吧～'
        ].join('\n')
      : [
          '你好呀，我们第一次连上啦。',
          '不过我现在还没有接入「大脑」（AI 模型），暂时没法和你正常对话。',
          '请先到 Codelf 设置里配置并激活一个模型 Provider，之后再给我发消息，我就会请你为我定义身份、完成首次激活。'
        ].join('\n')
    try {
      return await notifiable.notify(text)
    } catch {
      return false
    }
  }

  private async handleInbound(adapter: ChannelAdapter, msg: InboundMessage): Promise<void> {
    const session = this.getSession(msg)
    // 把会话数同步给适配器（供 UI 运行信息展示）。
    adapter.setSessionCount?.(this.sessions.size)
    const text = msg.text.trim()

    // 优先级 1：斜杠命令（任何状态下都先解析，见 7.7#1）。纯文本命令，不掺媒体。
    if (text.startsWith('/')) {
      await this.handleCommand(adapter, session, text)
      return
    }

    // 优先级 1.5：若有群聊正等机主（微信）回应交互项，这条消息作为该群的回答路由进编排器
    //（§8.4 host-relay：微信里只跟主管对话，群岗位的提问/审批由主管转你、你回的话回填给岗位）。
    {
      const { roomOrchestrator } = await import('../services/roomOrchestrator')
      const awaitingRoom = roomOrchestrator.roomAwaitingWeixin()
      if (awaitingRoom && !session.busy) {
        void roomOrchestrator.postUserMessageFromWeixin(awaitingRoom, text)
        return
      }
    }

    // 优先级 2：存在待回复的权限/提问/文件改动 → 解析为应答（阶段2）。
    // 注意：确认应答阶段只用文字，不处理媒体（避免误下载）。
    if (session.pendingPermission) {
      this.resolvePermissionReply(adapter, session, text)
      return
    }
    if (session.pendingFileChange) {
      this.resolveFileChangeReply(adapter, session, text)
      return
    }
    if (session.pendingQuestion) {
      this.resolveQuestionReply(session, text)
      return
    }

    // 优先级 3：引擎正在跑但无 pending → A1 忙提示，不打断。
    if (session.busy) {
      this.reply(adapter, session, '我还在处理上一条，如需中止请发 /stop。')
      return
    }

    // 优先级 4：空闲 → A3 合并窗口后开一轮。
    // 关键：媒体下载（CDN，有网络往返）推迟到窗口结束、真正建一轮时再统一做，
    // 不能在这里 await，否则会拖慢合并分组，导致同 3 秒内的多条消息被拆成多轮。
    if (getChannelsSettings().weixin.mergeWindowEnabled) {
      this.enqueueMerge(adapter, session, { text, raw: msg.raw })
    } else {
      void this.runTurnWithMedia(adapter, session, [{ text, raw: msg.raw }])
    }
  }

  // 从 InboundMessage.raw 里取出原始微信消息（含媒体项）。
  private extractWeixinMessage(raw: unknown): WeixinMessage | null {
    if (raw && typeof raw === 'object') {
      const r = raw as { message?: WeixinMessage }
      if (r.message && typeof r.message === 'object') return r.message
    }
    return null
  }

  // 从 raw 里取 context_token（typing/getConfig 用）。
  private extractContextToken(raw: unknown): string | undefined {
    if (raw && typeof raw === 'object') {
      const r = raw as { contextToken?: string; message?: WeixinMessage }
      if (typeof r.contextToken === 'string') return r.contextToken
      if (r.message?.context_token) return r.message.context_token
    }
    return undefined
  }

  // A3：3 秒合并窗口，把窗口内多条消息拼成一轮。
  private enqueueMerge(
    adapter: ChannelAdapter,
    session: SessionState,
    item: { text: string; raw: unknown }
  ): void {
    session.mergeBuffer.push(item)
    if (session.mergeTimer) clearTimeout(session.mergeTimer)
    session.mergeTimer = setTimeout(() => {
      session.mergeTimer = undefined
      const items = session.mergeBuffer.slice()
      session.mergeBuffer = []
      if (!items.length) return
      // 合并窗口结束后若引擎仍忙，走忙提示。
      if (session.busy) {
        this.reply(adapter, session, '我还在处理上一条，如需中止请发 /stop。')
        return
      }
      void this.runTurnWithMedia(adapter, session, items)
    }, MERGE_WINDOW_MS)
  }

  // 处理一组合并消息的入站媒体（CDN 下载解密），再拼成一轮交给 runTurn。
  // 媒体下载放在这里（窗口结束后）统一做，不影响合并分组的实时性。
  private async runTurnWithMedia(
    adapter: ChannelAdapter,
    session: SessionState,
    items: { text: string; raw: unknown }[]
  ): Promise<void> {
    // 提前占用，避免媒体下载期间（await）有新消息误判 busy=false 而并发起轮。
    session.busy = true
    // 记录起轮时的中止代次：下载途中若被 /stop /new，代次会变，下载完应放弃起轮。
    const gen = session.abortGeneration
    const texts: string[] = []
    for (const it of items) {
      let t = it.text.trim()
      const wxMsg = this.extractWeixinMessage(it.raw)
      if (wxMsg) {
        const media = await processInboundMedia(wxMsg, (m) => console.log(`[channel:weixin] ${m}`))
        if (media.images.length) session.pendingImages.push(...media.images)
        if (media.noteLines.length) {
          t = [t, ...media.noteLines].filter(Boolean).join('\n').trim()
        }
        if (!t && (media.images.length || media.noteLines.length)) {
          t = media.images.length ? '（用户发来一张图片）' : '（用户发来一条媒体消息）'
        }
      }
      if (t) texts.push(t)
    }
    // 下载期间若被 /stop /new 中止，放弃起轮（修复"下载途中喊停拦不住"）。
    if (session.abortGeneration !== gen) {
      session.busy = false
      return
    }
    const merged = texts.join('\n').trim()
    // 纯媒体无文字但有图片时，merged 已含占位；若彻底为空则不开轮。
    if (!merged && session.pendingImages.length === 0) {
      session.busy = false
      return
    }
    void this.runTurn(adapter, session, merged || '（用户发来一条媒体消息）')
  }

  private async handleCommand(
    adapter: ChannelAdapter,
    session: SessionState,
    text: string
  ): Promise<void> {
    const [cmd, ...rest] = text.split(/\s+/)
    const arg = rest.join(' ').trim()
    switch (cmd.toLowerCase()) {
      case '/stop':
        getQueryEngine(session.conversationId).cancel(session.conversationId)
        this.clearConfirmTimeout(session)
        if (session.mergeTimer) {
          clearTimeout(session.mergeTimer)
          session.mergeTimer = undefined
        }
        session.mergeBuffer = []
        session.pendingImages = []
        session.abortGeneration += 1
        session.busy = false
        session.pendingPermission = undefined
        session.pendingQuestion = undefined
        session.pendingFileChange = undefined
        this.reply(adapter, session, '已中止当前任务。')
        break
      case '/new':
        // 先 cancel 再 clear：clear 只清历史，不会中止正在跑的轮次/释放阻塞的 broker。
        // 若不先 cancel，正在跑的轮次会在被清空的历史上继续，行为未定义。
        getQueryEngine(session.conversationId).cancel(session.conversationId)
        getQueryEngine(session.conversationId).clear(session.conversationId)
        deleteSessionFile(this.persistId(session.conversationId))
        this.clearConfirmTimeout(session)
        if (session.mergeTimer) {
          clearTimeout(session.mergeTimer)
          session.mergeTimer = undefined
        }
        session.mergeBuffer = []
        session.pendingImages = []
        session.abortGeneration += 1
        session.busy = false
        session.pendingPermission = undefined
        session.pendingQuestion = undefined
        session.pendingFileChange = undefined
        this.reply(adapter, session, '已清空上下文，开始新会话。')
        break
      case '/cwd':
        await this.handleCwd(adapter, session, arg)
        break
      case '/remember':
        await this.handleRemember(adapter, session)
        break
      case '/persona':
        await this.handlePersona(adapter, session, arg)
        break
      case '/room':
        await this.handleRoom(adapter, session, arg)
        break
      case '/diag':
        await this.handleDiag(adapter, session)
        break
      default:
        this.reply(adapter, session, `未知命令：${cmd}。可用：/stop /new /cwd /remember /persona /room /diag`)
    }
  }

  // /room <任务>：把任务转交给绑定了微信的群聊编排器（§8.4 微信遥控）。
  // 不带参数时汇报当前群状态。回应经编排器推回微信，不在此 await。
  private async handleRoom(adapter: ChannelAdapter, session: SessionState, arg: string): Promise<void> {
    const { roomOrchestrator } = await import('../services/roomOrchestrator')
    const roomId = roomOrchestrator.findWeixinBoundRoom()
    if (!roomId) {
      this.reply(adapter, session, '还没有群聊绑定到微信。请先在桌面端建群并在群设置里绑定本微信会话。')
      return
    }
    if (!arg.trim()) {
      const statuses = roomOrchestrator.getSeatStatuses(roomId)
      const summary = statuses.length
        ? statuses.map((s) => `${s.seatId}:${s.state}`).join('，')
        : '群已就绪，暂无运行中的岗位。'
      this.reply(adapter, session, `当前群状态：${summary}`)
      return
    }
    this.reply(adapter, session, '已把任务转交给团队，开工后我会把关键节点同步给你。')
    void roomOrchestrator.postUserMessageFromWeixin(roomId, arg.trim())
  }

  // #2：/cwd 由通道层管理 currentWorkspace，不写引擎 override。
  private async handleCwd(
    adapter: ChannelAdapter,
    session: SessionState,
    arg: string
  ): Promise<void> {
    if (!arg || arg.toLowerCase() === 'reset') {
      session.currentWorkspace = this.resolveWorkspace()
      this.reply(
        adapter,
        session,
        session.currentWorkspace
          ? `已切回专属工作区：${session.currentWorkspace}`
          : '专属工作区未配置，当前为纯对话模式。'
      )
      return
    }
    try {
      await mkdir(arg, { recursive: true })
      session.currentWorkspace = arg
      this.reply(adapter, session, `已切换工作区到：${arg}`)
    } catch (e) {
      this.reply(adapter, session, `切换失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // /diag：自检——汇报通道连接、会话状态、能力支持、媒体目录、silk 转码可用性。
  private async handleDiag(adapter: ChannelAdapter, session: SessionState): Promise<void> {
    const st = adapter.getStatus()
    const lines: string[] = ['【微信通道自检】']
    lines.push(`连接状态：${st.status}${st.message ? `（${st.message}）` : ''}`)
    lines.push(`账号：${st.accountId ?? '未知'} 活跃会话数：${st.sessionCount ?? 0}`)
    lines.push(
      `本会话：busy=${session.busy} 工作区=${session.currentWorkspace ?? '无（纯对话）'} 待发图=${session.pendingImages.length}`
    )
    const pending =
      (session.pendingPermission ? '权限确认 ' : '') +
      (session.pendingFileChange ? '文件改动确认 ' : '') +
      (session.pendingQuestion ? '提问 ' : '')
    lines.push(`待确认：${pending.trim() || '无'}`)
    lines.push(
      `能力：发图=${adapter.sendImage ? '✓' : '✗'} 输入态=${adapter.startTyping ? '✓' : '✗'} 主动通知=${adapter.canNotify?.() ? '✓' : '✗'}`
    )
    const diag = await adapter.getDiagnostics?.()
    if (diag) {
      lines.push(`typing_ticket：${diag.typingTicketCached ? '已缓存' : '未缓存'}`)
      lines.push(`silk 转码：${diag.silkAvailable ? '可用' : '不可用（语音将降级存原始 silk）'}`)
      lines.push(`入站媒体目录：${diag.inboundDir}`)
    }
    lines.push(`合并窗口：${getChannelsSettings().weixin.mergeWindowEnabled ? '开' : '关'}`)
    this.reply(adapter, session, lines.join('\n'))
  }

  // /remember：显式触发"把本会话稳定知识晋升进 MEMORY.md"（6.6 第4点）。
  private async handleRemember(adapter: ChannelAdapter, session: SessionState): Promise<void> {
    if (!session.currentWorkspace) {
      this.reply(adapter, session, '当前为纯对话模式（无工作区），无项目记忆可写入。')
      return
    }
    if (session.busy) {
      this.reply(adapter, session, '正在处理上一条，请稍后再发 /remember。')
      return
    }
    const ok = await promoteSessionMemory({
      sessionId: session.conversationId,
      workspaceRoot: session.currentWorkspace
    })
    session.turnsSincePromote = 0
    this.reply(
      adapter,
      session,
      ok ? '已把本会话的稳定知识沉淀进项目记忆。' : '暂无可沉淀的稳定知识。'
    )
  }

  // /persona：查看当前人格；/persona reset 重新进入首次激活引导。
  private async handlePersona(
    adapter: ChannelAdapter,
    session: SessionState,
    arg: string
  ): Promise<void> {
    const sub = arg.trim().toLowerCase()
    if (sub === 'reset') {
      saveChannelsSettings({
        weixin: {
          ...getChannelsSettings().weixin,
          persona: { activated: false, selfName: '', ownerName: '', addressing: '', style: '' }
        }
      })
      this.reply(adapter, session, '已重置人格设定。下一条消息我会重新进行出厂设置。')
      return
    }
    const p = getChannelsSettings().weixin.persona
    if (!p.activated) {
      this.reply(adapter, session, '尚未完成出厂设置。给我发任意一条消息即可开始定义我的身份。')
      return
    }
    const lines = [
      '【当前人格设定】',
      `我的名字：${p.selfName || '（未设）'}`,
      `主人：${p.ownerName || '（未设）'}`,
      `我对你的称呼：${p.addressing || '（未设）'}`,
      `身份/风格：${p.style || '（未设）'}`,
      '',
      '想重新设定请发 /persona reset。'
    ]
    this.reply(adapter, session, lines.join('\n'))
  }


  private armConfirmTimeout(adapter: ChannelAdapter, session: SessionState): void {
    if (session.confirmTimer) clearTimeout(session.confirmTimer)
    session.confirmTimer = setTimeout(() => {
      session.confirmTimer = undefined
      const engine = getQueryEngine(session.conversationId)
      if (session.pendingPermission) {
        const id = session.pendingPermission.requestId
        session.pendingPermission = undefined
        engine.resolvePermission(id, 'deny')
      } else if (session.pendingFileChange) {
        const id = session.pendingFileChange.changeId
        session.pendingFileChange = undefined
        engine.resolveFileChange(id, 'reject')
      } else if (session.pendingQuestion) {
        const id = session.pendingQuestion.requestId
        session.pendingQuestion = undefined
        engine.resolveUserQuestion(id, { answer: '', cancelled: true })
      } else {
        return
      }
      this.reply(adapter, session, '确认超时（5 分钟无回复），已自动取消该操作。')
    }, CONFIRM_TIMEOUT_MS)
  }

  private clearConfirmTimeout(session: SessionState): void {
    if (session.confirmTimer) {
      clearTimeout(session.confirmTimer)
      session.confirmTimer = undefined
    }
  }

  private resolvePermissionReply(
    adapter: ChannelAdapter,
    session: SessionState,
    text: string
  ): void {
    const req = session.pendingPermission
    if (!req) return
    let decision: PermissionDecision | null = null
    if (text === '同意') decision = 'allow_once'
    else if (text === '拒绝') decision = 'deny'
    if (!decision) {
      this.reply(adapter, session, '请回复『同意』或『拒绝』。')
      return
    }
    this.clearConfirmTimeout(session)
    session.pendingPermission = undefined
    getQueryEngine(session.conversationId).resolvePermission(req.requestId, decision)
  }

  private resolveFileChangeReply(
    adapter: ChannelAdapter,
    session: SessionState,
    text: string
  ): void {
    const req = session.pendingFileChange
    if (!req) return
    let decision: FileChangeDecision | null = null
    if (text === '同意') decision = 'accept'
    else if (text === '拒绝') decision = 'reject'
    if (!decision) {
      this.reply(adapter, session, '请回复『同意』或『拒绝』。')
      return
    }
    this.clearConfirmTimeout(session)
    session.pendingFileChange = undefined
    getQueryEngine(session.conversationId).resolveFileChange(req.changeId, decision)
  }

  private resolveQuestionReply(session: SessionState, text: string): void {
    const req = session.pendingQuestion
    if (!req) return
    this.clearConfirmTimeout(session)
    session.pendingQuestion = undefined
    getQueryEngine(session.conversationId).resolveUserQuestion(req.requestId, { answer: text })
  }

  // 跑一轮对话：构造 payload、消费事件流、翻译回微信。
  private async runTurn(
    adapter: ChannelAdapter,
    session: SessionState,
    message: string
  ): Promise<void> {
    session.busy = true
    markActive(session.conversationId)
    // 人格：未激活 → 本轮进入「首次激活引导」模式；已激活 → 注入永久人格。
    const persona = getChannelsSettings().weixin.persona
    const activation = !persona.activated
    // 首次激活依赖模型来主导问答。若还没配 Provider，引擎只会回「尚未配置模型」，
    // 激活永远完不成。这里提前拦一下，给一句更明确的引导，避免空转进引擎。
    if (activation && !getActiveProfileId()) {
      this.reply(
        adapter,
        session,
        '我还没有接入大脑（AI 模型）。请先在 Codelf 设置里配置并激活一个模型 Provider，配置完成后再给我发消息，我就会进行首次激活、请你定义我的身份。'
      )
      clearActive(session.conversationId)
      session.busy = false
      return
    }
    // E15：工作区不存在则自动创建；并确保项目记忆文件存在（6.6）。
    if (session.currentWorkspace) {
      try {
        await mkdir(session.currentWorkspace, { recursive: true })
        await ensureProjectMemory(session.currentWorkspace)
      } catch {
        // 创建失败则降级纯对话。
        session.currentWorkspace = null
      }
    }

    const payload: AiSendPayload = {
      sessionId: session.conversationId,
      turnId: randomUUID(),
      message,
      // 与 UI 端"自动审批"开关一致：acceptEdits 自动放行文件/普通命令，危险操作仍拦。
      permissionMode: getPermissionMode(),
      sessionCwd: session.currentWorkspace,
      ...(session.pendingImages.length ? { images: session.pendingImages.slice() } : {}),
      // 让 agent 感知「自己正被远程用户通过 IM 聊天」，并知道如何发文件（无需工具）。
      channel: this.describeChannel(adapter),
      persona: activation
        ? { activationMode: true }
        : {
            selfName: persona.selfName,
            ownerName: persona.ownerName,
            addressing: persona.addressing,
            style: persona.style
          }
    }
    // 图片已并入本轮 payload，清空缓冲，避免下轮重复发送。
    session.pendingImages = []

    // 激活轮：不立即把文字发回，先累积，轮末剥离 codelf-persona 落盘块再发干净文本。
    const activationBuf: string[] = []
    const bridge = new SessionBridge({
      send: (t) => (activation ? activationBuf.push(t) : this.reply(adapter, session, t))
    })
    const engine = getQueryEngine(session.conversationId)

    // B：开始"正在输入"状态（best-effort，不阻塞）。
    const contextToken = this.extractContextToken(session.lastRaw)
    void adapter.startTyping?.(session.conversationId, session.senderId, contextToken)

    // B5：收集本轮生成的图片 artifact URL，轮次结束后作为图片发回微信。
    const imageUrls = new Set<string>()

    try {
      for await (const ev of engine.submitTurn(payload)) {
        // B：工具开始执行时重新点亮"正在输入"。微信收到上一段文字后会清掉 typing，
        // 这里在工具干活阶段补上，让你看到"发一段→在干活→再发结果"的节奏。
        if (ev.type === 'tool_call_start') {
          void adapter.startTyping?.(session.conversationId, session.senderId, contextToken)
        }
        // B5：从文本增量里提取生成图片的 artifact 链接，留到轮末发图。
        // 正文里开启 preview 协议：agent 把截图放进回复 = 有意发给用户。
        if (ev.type === 'text_delta' && typeof ev.content === 'string') {
          this.collectImageUrls(ev.content, imageUrls, true)
        }
        // 生图工具(GenerateImage/EditImage)与截图工具(DesktopScreenshot/Screen)把图片 markdown
        // 放在工具结果里。这里同时采集 artifact(生成图) 与 preview(截图) 协议：
        // 点击/输入后的"自动截图"只在 images 字段、结果文本里不含 preview 链接，不会被误采，
        // 因此只会抓到「用户显式要的截图」，不会因多步操作刷屏。
        if (
          (ev.type === 'tool_call_result' || ev.type === 'subagent_tool_result') &&
          typeof ev.result === 'string' &&
          !ev.isError
        ) {
          this.collectImageUrls(ev.result, imageUrls, true)
        }
        // 阶段2：拦截需要等待用户回复的事件，记录 pending 并发微信询问。
        if (ev.type === 'permission_request') {
          session.pendingPermission = { requestId: ev.requestId }
          this.armConfirmTimeout(adapter, session)
          this.reply(
            adapter,
            session,
            `Agent 想执行 ${ev.tool}：${ev.summary}\n回复『同意』或『拒绝』。`
          )
          continue
        }
        if (ev.type === 'user_question') {
          session.pendingQuestion = { requestId: ev.requestId }
          this.armConfirmTimeout(adapter, session)
          // B6：若此前已生成图片，先把图发出去，再发问题，形成"带预览图的提问"。
          if (imageUrls.size) {
            await this.deliverImages(adapter, session, imageUrls)
            imageUrls.clear()
          }
          const suggestions = ev.suggestions?.length ? `\n可选：${ev.suggestions.join(' / ')}` : ''
          this.reply(adapter, session, `${ev.question}${suggestions}`)
          continue
        }
        // 文件改动提议：仅在 default 模式下引擎会阻塞等待 accept/reject，才需转微信确认。
        // acceptEdits（自动审批）下引擎会自动应用，这事件只是"即将写入"的通知，
        // 不能拦成确认点——否则会出现"发了同意/拒绝提示，但文件已自动创建"的脱节。
        if (ev.type === 'file_change_proposed') {
          if (payload.permissionMode === 'acceptEdits') {
            bridge.consume(ev)
            continue
          }
          session.pendingFileChange = { changeId: ev.changeId }
          this.armConfirmTimeout(adapter, session)
          this.reply(
            adapter,
            session,
            `Agent 想修改文件：${ev.path}\n${this.summarizeDiff(ev.diff)}\n回复『同意』或『拒绝』。`
          )
          continue
        }
        bridge.consume(ev)
      }
      // B5：轮末把本轮生成的图片逐张发回微信（best-effort，失败仅日志）。
      await this.deliverImages(adapter, session, imageUrls)
      // 激活轮：合并本轮文本，剥离 codelf-persona 落盘块，把干净文本发回微信。
      if (activation) {
        this.finishActivationTurn(adapter, session, activationBuf.join('\n\n'))
      }
    } catch (err) {
      bridge.flush()
      if (activation && activationBuf.length) {
        this.finishActivationTurn(adapter, session, activationBuf.join('\n\n'))
      }
      this.reply(adapter, session, `出错了：${err instanceof Error ? err.message : '未知错误'}`)
    } finally {
      // B：停止"正在输入"状态。
      adapter.stopTyping?.(session.conversationId, session.senderId)
      this.clearConfirmTimeout(session)
      clearActive(session.conversationId)
      session.busy = false
      // 6.6：一轮结束后落盘会话历史，供下次重启续接。
      this.persistSession(session)
      // 6.6 第4点：每 N 轮自动把稳定知识晋升进 MEMORY.md（best-effort，不阻塞回信）。
      if (session.currentWorkspace) {
        session.turnsSincePromote += 1
        if (session.turnsSincePromote >= PROMOTE_EVERY_N_TURNS) {
          session.turnsSincePromote = 0
          const ws = session.currentWorkspace
          void promoteSessionMemory({ sessionId: session.conversationId, workspaceRoot: ws }).catch(
            () => {}
          )
        }
      }
    }
  }

  // 激活轮收尾：从模型本轮全部文本里剥离 codelf-persona JSON 块。
  // 解析成功 → 落盘人格、标记 activated，发回干净文本 + 完成提示；
  // 没有块（信息还不全）→ 原样发回文本，下一条消息继续引导。
  private finishActivationTurn(
    adapter: ChannelAdapter,
    session: SessionState,
    fullText: string
  ): void {
    const re = /```codelf-persona\s*([\s\S]*?)```/i
    const m = re.exec(fullText)
    const cleaned = fullText.replace(re, '').replace(/\n{3,}/g, '\n\n').trim()
    if (!m) {
      if (cleaned) this.reply(adapter, session, cleaned)
      return
    }
    let parsed: { selfName?: string; ownerName?: string; addressing?: string; style?: string } | null =
      null
    try {
      parsed = JSON.parse(m[1].trim())
    } catch {
      parsed = null
    }
    if (!parsed || typeof parsed !== 'object') {
      if (cleaned) this.reply(adapter, session, cleaned)
      this.reply(adapter, session, '（人格信息解析失败，我们再确认一次吧）')
      return
    }
    const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
    saveChannelsSettings({
      weixin: {
        ...getChannelsSettings().weixin,
        persona: {
          activated: true,
          selfName: str(parsed.selfName),
          ownerName: str(parsed.ownerName),
          addressing: str(parsed.addressing),
          style: str(parsed.style),
          activatedAt: Date.now()
        }
      }
    })
    if (cleaned) this.reply(adapter, session, cleaned)
    this.reply(adapter, session, '出厂设置完成，我已经记住了自己的身份。以后就这样陪着你。')
  }

  // 把适配器映射成 prompt 用的通道场景描述。canSendFile 取决于适配器是否实现 sendFile。
  private describeChannel(adapter: ChannelAdapter): AiSendPayload['channel'] {
    const labels: Record<string, string> = { weixin: '微信' }
    return {
      id: adapter.channelId,
      label: labels[adapter.channelId] ?? adapter.channelId,
      canSendFile: typeof adapter.sendFile === 'function',
      canSendImage: typeof adapter.sendImage === 'function'
    }
  }

  // B5：从一段文本里抽取图片 markdown 链接。
  // includePreview=true 时同时捕获 codelf-preview://（截图等临时预览）——仅用于 agent 正文，
  // 表示「有意发给用户」；工具结果不开启，避免把每张内部导航截图都推给用户造成刷屏。
  private collectImageUrls(text: string, sink: Set<string>, includePreview = false): void {
    const scheme = includePreview ? '(?:codelf-artifact|codelf-preview)' : 'codelf-artifact'
    const re = new RegExp(`!\\[[^\\]]*\\]\\((${scheme}:\\/\\/[^)\\s]+)\\)`, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      sink.add(m[1])
    }
  }

  // 供延迟工具（SendWeixinFile）调用：把一个本地文件发给指定会话的用户。
  // 按 sessionId 回查会话与所属 adapter，复用其 sendFile（CDN 上传 + 文件消息 + 串行队列）。
  // 返回是否送达；会话不存在或通道不支持发文件时返回 false。
  async sendFileToConversation(
    conversationId: string,
    filePath: string,
    fileName: string
  ): Promise<boolean> {
    const session = this.sessions.get(conversationId)
    if (!session) return false
    const adapter = this.adapters.get(session.channelId)
    if (!adapter?.sendFile) return false
    try {
      await adapter.sendFile(conversationId, session.senderId, filePath, fileName, session.lastRaw)
      console.log(`[channel:${adapter.channelId}] 已发文件回 IM ${fileName}`)
      return true
    } catch (e) {
      console.error(`[channel] 发文件失败：${String(e)}`)
      return false
    }
  }

  // B5：把收集到的图片读取并发回微信。仅支持图片发送的适配器才执行。
  private async deliverImages(
    adapter: ChannelAdapter,
    session: SessionState,
    urls: Set<string>
  ): Promise<void> {
    if (urls.size === 0 || !adapter.sendImage) return
    for (const url of urls) {
      try {
        const file = url.startsWith('codelf-preview://')
          ? await this.readPreviewFile(url)
          : await readArtifactFile(url)
        if (!file || !file.mime.startsWith('image/')) continue
        const dataUrl = `data:${file.mime};base64,${file.data.toString('base64')}`
        await adapter.sendImage(session.conversationId, session.senderId, dataUrl, session.lastRaw)
        console.log(`[channel:weixin] 已发图回微信 ${file.data.length}字节 mime=${file.mime}`)
      } catch (e) {
        console.error(`[channel] 发图失败：${String(e)}`)
      }
    }
  }

  // 读取 codelf-preview://<id> 临时预览图（截图等）。
  private async readPreviewFile(url: string): Promise<{ data: Buffer; mime: string } | null> {
    const id = url.slice('codelf-preview://'.length).replace(/[/?#].*$/, '')
    if (!id) return null
    return readBrowserPreview(id)
  }

  // diff 摘要：取前若干行，过长截断，避免刷屏。
  private summarizeDiff(diff: string, maxLines = 20): string {
    if (!diff) return '(无差异预览)'
    const lines = diff.split('\n')
    if (lines.length <= maxLines) return diff
    return `${lines.slice(0, maxLines).join('\n')}\n…（共 ${lines.length} 行，已截断）`
  }

  // 把文本发回微信（带回信目标 + 原始消息的 context_token）。
  private reply(adapter: ChannelAdapter, session: SessionState, text: string): void {
    void adapter
      .sendMessage({ conversationId: session.conversationId, text }, session.senderId, session.lastRaw)
      .catch((e) => console.error(`[channel] 回信失败：${String(e)}`))
  }
}

let managerSingleton: ChannelManager | null = null

export function getChannelManager(): ChannelManager {
  if (!managerSingleton) managerSingleton = new ChannelManager()
  return managerSingleton
}
